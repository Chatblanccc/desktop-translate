#include "desktop_translate/native/selection/selection_pipeline.h"

#include <Windows.h>
#include <objbase.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <future>
#include <thread>
#include <utility>
#include <string_view>

#include "desktop_translate/native/coordinates/coordinates.h"
#include "desktop_translate/native/core/utf8.h"

namespace desktop_translate::native {
namespace {

std::string NewSelectionId(std::uint64_t fallback_value) {
  GUID guid{};
  if (FAILED(CoCreateGuid(&guid))) {
    char fallback[37]{};
    std::snprintf(fallback, sizeof(fallback), "00000000-0000-4000-8000-%012llx",
                  static_cast<unsigned long long>(fallback_value & 0xffffffffffffULL));
    return fallback;
  }
  char value[37]{};
  std::snprintf(value, sizeof(value),
                "%08lx-%04x-%04x-%04x-%012llx",
                static_cast<unsigned long>(guid.Data1),
                static_cast<unsigned int>(guid.Data2),
                static_cast<unsigned int>(guid.Data3),
                static_cast<unsigned int>((static_cast<unsigned int>(guid.Data4[0]) << 8U) |
                                          guid.Data4[1]),
                static_cast<unsigned long long>(guid.Data4[2]) << 40U |
                    static_cast<unsigned long long>(guid.Data4[3]) << 32U |
                    static_cast<unsigned long long>(guid.Data4[4]) << 24U |
                    static_cast<unsigned long long>(guid.Data4[5]) << 16U |
                    static_cast<unsigned long long>(guid.Data4[6]) << 8U |
                    static_cast<unsigned long long>(guid.Data4[7]));
  return value;
}

std::int64_t SquaredDistance(PhysicalPoint first, PhysicalPoint second) {
  const auto dx = static_cast<std::int64_t>(first.x) - second.x;
  const auto dy = static_cast<std::int64_t>(first.y) - second.y;
  return dx * dx + dy * dy;
}

bool HasText(std::string_view text) {
  return std::any_of(text.begin(), text.end(), [](unsigned char c) {
    return c >= 0x80U || (c != ' ' && c != '\t' && c != '\r' && c != '\n');
  });
}

std::string Utf16ToUtf8(std::wstring_view text) {
  if (text.empty()) return {};
  const auto bytes = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                                         nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string value(static_cast<std::size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), value.data(), bytes,
                      nullptr, nullptr);
  return value;
}

std::wstring Utf8ToUtf16(std::string_view text) {
  if (text.empty()) return {};
  const auto units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                         static_cast<int>(text.size()), nullptr, 0);
  if (units <= 0) return {};
  std::wstring value(static_cast<std::size_t>(units), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                          static_cast<int>(text.size()), value.data(), units) != units) {
    return {};
  }
  return value;
}

bool WindowsCaseInsensitiveEquals(std::string_view first, std::string_view second) {
  const auto first_wide = Utf8ToUtf16(first);
  const auto second_wide = Utf8ToUtf16(second);
  return CompareStringOrdinal(first_wide.data(), static_cast<int>(first_wide.size()),
                              second_wide.data(), static_cast<int>(second_wide.size()), TRUE) ==
         CSTR_EQUAL;
}

std::string ProcessBaseName(std::uint32_t pid) {
  const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return {};
  std::wstring path(32768U, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  const bool read = QueryFullProcessImageNameW(process, 0U, path.data(), &size) == TRUE;
  CloseHandle(process);
  if (!read) return {};
  path.resize(size);
  const auto slash = path.find_last_of(L"\\/");
  return Utf16ToUtf8(slash == std::wstring::npos ? std::wstring_view(path)
                                                 : std::wstring_view(path).substr(slash + 1U));
}

}  // namespace

SelectionPipeline::SelectionPipeline(MouseHook& mouse_hook, UiaWorker& uia_worker,
                                     IScreenCapture& screen_capture, IOcrEngine& ocr_engine,
                                     ResultSink result_sink)
    : mouse_hook_(mouse_hook),
      uia_worker_(uia_worker),
      screen_capture_(screen_capture),
      ocr_engine_(ocr_engine),
      result_sink_(std::move(result_sink)) {}

SelectionPipeline::~SelectionPipeline() { Stop(); }

bool SelectionPipeline::Start() {
  bool expected = false;
  if (!running_.compare_exchange_strong(expected, true)) return true;
  mouse_hook_.DiscardPendingEvents();
  try {
    thread_ = std::thread(&SelectionPipeline::ThreadMain, this);
    return true;
  } catch (...) {
    running_.store(false, std::memory_order_release);
    return false;
  }
}

void SelectionPipeline::Stop() noexcept {
  if (!running_.exchange(false, std::memory_order_acq_rel)) return;
  mouse_hook_.WakeConsumer();
  if (thread_.joinable()) thread_.join();
}

bool SelectionPipeline::SetConfig(SelectionPipelineConfig config) noexcept {
  if (running_.load(std::memory_order_acquire)) return false;
  if (config.settle_delay_ms > 500U || config.minimum_drag_distance_px < 2.0 ||
      config.minimum_drag_distance_px > 64.0 || config.uia_timeout_ms < 50U ||
      config.uia_timeout_ms > 2000U || config.ocr_timeout_ms < 250U ||
      config.ocr_timeout_ms > 10000U) {
    return false;
  }
  if (config.excluded_process_names.size() > 256U ||
      std::any_of(config.excluded_process_names.begin(), config.excluded_process_names.end(),
                  [](const std::string& name) { return name.empty() || name.size() > 260U; })) {
    return false;
  }
  config_ = config;
  return true;
}

void SelectionPipeline::ThreadMain() noexcept {
  bool button_down = false;
  bool moved = false;
  bool last_click_valid = false;
  bool current_alt_down = false;
  PhysicalPoint down_point{};
  PhysicalPoint last_click_point{};
  std::uint64_t last_click_tick = 0;

  while (running_.load(std::memory_order_acquire)) {
    MouseEvent event;
    if (!mouse_hook_.WaitAndPop(event, 100U)) continue;
    if (event.injected) continue;

    switch (event.kind) {
      case MouseEventKind::kLeftDown:
        button_down = true;
        moved = false;
        current_alt_down = event.alt_down;
        down_point = event.point;
        break;
      case MouseEventKind::kMove:
        if (button_down) {
          const auto minimum = config_.minimum_drag_distance_px;
          moved = moved || static_cast<double>(SquaredDistance(down_point, event.point)) >=
                               minimum * minimum;
          current_alt_down = current_alt_down || event.alt_down;
        }
        break;
      case MouseEventKind::kLeftUp: {
        if (!button_down) break;
        button_down = false;
        current_alt_down = current_alt_down || event.alt_down;
        const auto minimum = config_.minimum_drag_distance_px;
        moved = moved || static_cast<double>(SquaredDistance(down_point, event.point)) >=
                             minimum * minimum;
        const bool double_click = !moved && last_click_valid &&
            event.tick_ms >= last_click_tick &&
            event.tick_ms - last_click_tick <= GetDoubleClickTime() &&
            std::abs(event.point.x - last_click_point.x) <= GetSystemMetrics(SM_CXDOUBLECLK) / 2 &&
            std::abs(event.point.y - last_click_point.y) <= GetSystemMetrics(SM_CYDOUBLECLK) / 2;

        if (!moved) {
          last_click_valid = true;
          last_click_point = event.point;
          last_click_tick = event.tick_ms;
        } else {
          last_click_valid = false;
        }
        if (!moved && !double_click) break;

        PhysicalRect roi = moved
            ? RectFromPoints(down_point, event.point, 8)
            : PhysicalRect{event.point.x - 160, event.point.y - 40, 320, 80};
        roi = ClampToVirtualDesktop(roi);
        if (roi.IsEmpty()) break;

        const bool allow_ocr = config_.enable_ocr_fallback &&
                               (!config_.ocr_requires_alt_drag || current_alt_down);
        ResolveSelection(event.generation, event.point, roi, allow_ocr);
        break;
      }
    }
  }
}

void SelectionPipeline::ResolveSelection(std::uint64_t generation, PhysicalPoint anchor,
                                         PhysicalRect roi, bool allow_ocr) noexcept {
  const auto cancelled = [this, generation] {
    return !running_.load(std::memory_order_acquire) ||
           generation != mouse_hook_.latest_generation();
  };
  if (cancelled()) return;

  SelectionPipelineResult result;
  result.selection_id = NewSelectionId(generation);
  result.release_point = anchor;
  result.attempted_roi = roi;

  const POINT point{anchor.x, anchor.y};
  const HWND hwnd = WindowFromPoint(point);
  result.target_hwnd = reinterpret_cast<std::uintptr_t>(hwnd);
  if (hwnd != nullptr) {
    DWORD target_pid = 0;
    GetWindowThreadProcessId(hwnd, &target_pid);
    result.target_pid = static_cast<std::uint32_t>(target_pid);
  }
  if (!config_.excluded_process_names.empty()) {
    const auto process_name = ProcessBaseName(result.target_pid);
    if (std::any_of(config_.excluded_process_names.begin(),
                    config_.excluded_process_names.end(), [&](const std::string& excluded) {
                      return WindowsCaseInsensitiveEquals(excluded, process_name);
                    })) {
      return;
    }
  }

  if (config_.settle_delay_ms != 0U) {
    std::this_thread::sleep_for(std::chrono::milliseconds(config_.settle_delay_ms));
  }
  if (cancelled()) return;

  SelectionResult uia_result{ErrorCode::kUiaUnavailable, {}, "UIA is disabled"};
  if (config_.enable_uia) {
    if (auto future = uia_worker_.TryGetSelection(anchor, config_.uia_timeout_ms); future) {
      if (future->wait_for(std::chrono::milliseconds(config_.uia_timeout_ms)) ==
          std::future_status::ready) {
        try {
          uia_result = future->get();
        } catch (...) {
          uia_result = {ErrorCode::kInternalError, {}, "UIA worker promise failed"};
        }
      } else {
        uia_result = {ErrorCode::kUiaTimeout, {}, "UIA selection request timed out"};
      }
    } else {
      uia_result = {ErrorCode::kUiaUnavailable, {}, "UIA worker is busy or stopping"};
    }
  }

  if (uia_result.ok()) {
    if (cancelled()) return;
    uia_result.selection.text_utf8 =
        TruncateUtf8ToUtf16Units(uia_result.selection.text_utf8, 32768U);
    if (uia_result.selection.bounds.size() > 256U) {
      uia_result.selection.bounds.resize(256U);
    }
    result.source = "uia";
    result.selection = std::move(uia_result);
    result.confidence = 1.0F;
    try { result_sink_(std::move(result)); } catch (...) {}
    return;
  }

  // Never turn a password-field rejection into a pixel capture.
  if (uia_result.error == ErrorCode::kUiaPasswordField || !allow_ocr) {
    if (cancelled()) return;
    result.source = "none";
    result.selection = std::move(uia_result);
    result.capture_error = ErrorCode::kCaptureUnavailable;
    result.ocr_error = ErrorCode::kOcrUnavailable;
    try { result_sink_(std::move(result)); } catch (...) {}
    return;
  }

  // Do not capture pixels when no recognizer can consume them.
  if (!ocr_engine_.available()) {
    result.source = "none";
    result.selection = {ErrorCode::kOcrUnavailable, {}, "OCR runtime is not available"};
    result.capture_error = ErrorCode::kCaptureUnavailable;
    result.ocr_error = ErrorCode::kOcrUnavailable;
    if (!cancelled()) {
      try { result_sink_(std::move(result)); } catch (...) {}
    }
    return;
  }

  CaptureResult capture;
  try {
    capture = screen_capture_.CaptureRoi(roi, std::min(config_.ocr_timeout_ms, 1000U));
  } catch (...) {
    result.source = "none";
    result.selection = {ErrorCode::kInternalError, {}, "screen capture raised an exception"};
    result.capture_error = ErrorCode::kInternalError;
    result.ocr_error = ErrorCode::kOcrUnavailable;
    if (!cancelled()) {
      try { result_sink_(std::move(result)); } catch (...) {}
    }
    return;
  }
  if (cancelled()) return;
  result.capture_error = capture.error;
  if (!capture.ok()) {
    result.source = "none";
    result.selection = {capture.error, {}, std::move(capture.detail)};
    result.ocr_error = ErrorCode::kOcrUnavailable;
    try { result_sink_(std::move(result)); } catch (...) {}
    return;
  }

  OcrResult ocr;
  try {
    ocr = ocr_engine_.Recognize(capture.bitmap, config_.ocr_timeout_ms);
  } catch (...) {
    result.source = "none";
    result.selection = {ErrorCode::kInternalError, {}, "OCR engine raised an exception"};
    result.ocr_error = ErrorCode::kInternalError;
    if (!cancelled()) {
      try { result_sink_(std::move(result)); } catch (...) {}
    }
    return;
  }
  if (cancelled()) return;
  result.ocr_error = ocr.error;
  if (!ocr.ok()) {
    if (cancelled()) return;
    result.source = "none";
    result.selection = {ocr.error, {}, std::move(ocr.detail)};
    try { result_sink_(std::move(result)); } catch (...) {}
    return;
  }

  TextSelection selection;
  float confidence_sum = 0.0F;
  std::size_t confidence_count = 0;
  for (auto& line : ocr.lines) {
    if (!HasText(line.text_utf8)) continue;
    if (confidence_count >= 256U) break;
    if (!selection.text_utf8.empty()) selection.text_utf8.push_back('\n');
    selection.text_utf8 += line.text_utf8;
    selection.bounds.push_back({capture.bitmap.desktop_bounds.x + line.bounds.x,
                                capture.bitmap.desktop_bounds.y + line.bounds.y,
                                line.bounds.width, line.bounds.height});
    confidence_sum += std::isfinite(line.confidence)
                          ? std::clamp(line.confidence, 0.0F, 1.0F)
                          : 0.0F;
    ++confidence_count;
  }
  if (!HasText(selection.text_utf8)) {
    if (cancelled()) return;
    result.source = "none";
    result.selection = {ErrorCode::kUiaNoSelection, {}, "OCR returned no usable text"};
    try { result_sink_(std::move(result)); } catch (...) {}
    return;
  }
  selection.text_utf8 = TruncateUtf8ToUtf16Units(selection.text_utf8, 32768U);
  if (cancelled()) return;

  result.source = "ocr";
  result.selection = {ErrorCode::kOk, std::move(selection), {}};
  result.confidence = confidence_count == 0U
      ? 0.0F
      : confidence_sum / static_cast<float>(confidence_count);
  try { result_sink_(std::move(result)); } catch (...) {}
}

}  // namespace desktop_translate::native
