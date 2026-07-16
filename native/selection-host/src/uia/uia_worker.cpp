#include "desktop_translate/native/uia/uia_worker.h"

#include <Windows.h>
#include <objbase.h>
#include <UIAutomation.h>
#include <oleauto.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cwchar>
#include <limits>
#include <string_view>
#include <utility>

namespace desktop_translate::native {
namespace {

using Microsoft::WRL::ComPtr;

struct SafeArrayOwner {
  SAFEARRAY* value{};
  ~SafeArrayOwner() {
    if (value != nullptr) SafeArrayDestroy(value);
  }
};

std::string Utf16ToUtf8(const wchar_t* value, int length) {
  if (value == nullptr || length <= 0) return {};
  int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, length, nullptr, 0,
                                  nullptr, nullptr);
  if (bytes == 0) {
    bytes = WideCharToMultiByte(CP_UTF8, 0, value, length, nullptr, 0, nullptr, nullptr);
  }
  if (bytes == 0) return {};
  std::string result(static_cast<std::size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, length, result.data(), bytes, nullptr, nullptr);
  return result;
}

bool HasNonWhitespace(std::string_view text) {
  return std::any_of(text.begin(), text.end(), [](unsigned char c) {
    return c >= 0x80U || (c != ' ' && c != '\t' && c != '\r' && c != '\n');
  });
}

}  // namespace

bool IsMaskedPasswordRepresentation(std::wstring_view text) noexcept {
  if (text.empty()) return false;
  bool found_mask = false;
  for (const wchar_t character : text) {
    if (character == L' ' || character == L'\t' || character == L'\r' ||
        character == L'\n') {
      continue;
    }
    if (character == L'*' || character == L'\u2022' || character == L'\u25CF' ||
        character == L'\u25E6' || character == L'\u25A0') {
      found_mask = true;
      continue;
    }
    return false;
  }
  return found_mask;
}

namespace {

struct PatternLookup {
  ErrorCode error{ErrorCode::kUiaUnavailable};
  ComPtr<IUIAutomationTextPattern> pattern;
};

using Deadline = std::chrono::steady_clock::time_point;

bool CancelledOrExpired(const std::atomic<bool>& stop_requested, Deadline deadline) {
  return stop_requested.load(std::memory_order_acquire) ||
         std::chrono::steady_clock::now() >= deadline;
}

PatternLookup FindTextPattern(IUIAutomation* automation, IUIAutomationElement* start,
                              const std::atomic<bool>& stop_requested, Deadline deadline) {
  if (automation == nullptr || start == nullptr) return {};
  if (CancelledOrExpired(stop_requested, deadline)) {
    return {ErrorCode::kUiaTimeout, {}};
  }
  ComPtr<IUIAutomationTreeWalker> walker;
  automation->get_ControlViewWalker(&walker);

  ComPtr<IUIAutomationElement> current(start);
  ComPtr<IUIAutomationTextPattern> first_pattern;
  for (int depth = 0; current && depth < 12; ++depth) {
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}};
    }
    BOOL is_password = FALSE;
    if (SUCCEEDED(current->get_CurrentIsPassword(&is_password)) && is_password == TRUE) {
      return {ErrorCode::kUiaPasswordField, {}};
    }
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}};
    }

    // Keep the nearest TextPattern, but do not return until the ancestor chain
    // has been checked. Chromium can expose a non-password text descendant
    // inside an IsPassword=true edit control; returning early would publish
    // masked bullets instead of enforcing the password boundary.
    if (!first_pattern) {
      ComPtr<IUnknown> pattern_unknown;
      if (SUCCEEDED(current->GetCurrentPattern(UIA_TextPatternId, &pattern_unknown)) &&
          pattern_unknown != nullptr) {
        ComPtr<IUIAutomationTextPattern> pattern;
        if (SUCCEEDED(pattern_unknown.As(&pattern)) && pattern != nullptr) {
          first_pattern = std::move(pattern);
        }
      }
    }
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}};
    }

    if (!walker) break;
    ComPtr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElement(current.Get(), &parent)) || !parent) break;
    current = std::move(parent);
  }
  if (first_pattern) return {ErrorCode::kOk, std::move(first_pattern)};
  return {ErrorCode::kUiaUnavailable, {}};
}

SelectionResult ReadSelection(IUIAutomation* automation, PhysicalPoint point,
                              const std::atomic<bool>& stop_requested, Deadline deadline) {
  if (automation == nullptr) {
    return {ErrorCode::kUiaUnavailable, {}, "UI Automation did not initialize"};
  }

  POINT win32_point{point.x, point.y};
  if (CancelledOrExpired(stop_requested, deadline)) {
    return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
  }
  ComPtr<IUIAutomationElement> element;
  if (FAILED(automation->ElementFromPoint(win32_point, &element)) || !element) {
    return {ErrorCode::kUiaUnavailable, {}, "ElementFromPoint failed"};
  }
  if (CancelledOrExpired(stop_requested, deadline)) {
    return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
  }

  auto lookup = FindTextPattern(automation, element.Get(), stop_requested, deadline);
  if (lookup.error == ErrorCode::kUiaPasswordField) {
    return {lookup.error, {}, "password fields are never read or captured"};
  }
  if (lookup.error == ErrorCode::kUiaTimeout) {
    return {lookup.error, {}, "UI Automation request deadline expired"};
  }
  if (!lookup.pattern) {
    // Some providers expose TextPattern only from the focused element. Limit
    // this fallback to the window under the pointer to avoid stale selection.
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
    }
    ComPtr<IUIAutomationElement> focused;
    if (SUCCEEDED(automation->GetFocusedElement(&focused)) && focused) {
      if (CancelledOrExpired(stop_requested, deadline)) {
        return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
      }
      UIA_HWND point_hwnd{};
      UIA_HWND focused_hwnd{};
      element->get_CurrentNativeWindowHandle(&point_hwnd);
      if (CancelledOrExpired(stop_requested, deadline)) {
        return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
      }
      focused->get_CurrentNativeWindowHandle(&focused_hwnd);
      const auto point_native_hwnd = reinterpret_cast<HWND>(point_hwnd);
      const auto focused_native_hwnd = reinterpret_cast<HWND>(focused_hwnd);
      const HWND point_root = GetAncestor(
          point_native_hwnd != nullptr ? point_native_hwnd : WindowFromPoint(win32_point), GA_ROOT);
      const HWND focused_root = GetAncestor(focused_native_hwnd, GA_ROOT);
      if (point_root != nullptr && point_root == focused_root) {
        lookup = FindTextPattern(automation, focused.Get(), stop_requested, deadline);
      }
    }
  }
  if (lookup.error == ErrorCode::kUiaPasswordField) {
    return {lookup.error, {}, "password fields are never read or captured"};
  }
  if (!lookup.pattern) {
    if (lookup.error == ErrorCode::kUiaTimeout) {
      return {lookup.error, {}, "UI Automation request deadline expired"};
    }
    return {ErrorCode::kUiaUnavailable, {}, "target does not expose TextPattern"};
  }

  if (CancelledOrExpired(stop_requested, deadline)) {
    return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
  }
  ComPtr<IUIAutomationTextRangeArray> ranges;
  if (FAILED(lookup.pattern->GetSelection(&ranges)) || !ranges) {
    return {ErrorCode::kUiaNoSelection, {}, "TextPattern GetSelection failed"};
  }
  if (CancelledOrExpired(stop_requested, deadline)) {
    return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
  }

  int range_count = 0;
  if (CancelledOrExpired(stop_requested, deadline)) {
    return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
  }
  if (FAILED(ranges->get_Length(&range_count)) || range_count <= 0) {
    return {ErrorCode::kUiaNoSelection, {}, "provider returned no text ranges"};
  }

  TextSelection selection;
  range_count = std::min(range_count, 256);
  for (int index = 0; index < range_count; ++index) {
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
    }
    ComPtr<IUIAutomationTextRange> range;
    if (FAILED(ranges->GetElement(index, &range)) || !range) continue;
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
    }

    BSTR text = nullptr;
    const auto text_hr = range->GetText(8192, &text);
    if (SUCCEEDED(text_hr) && text != nullptr) {
      if (IsMaskedPasswordRepresentation(
              std::wstring_view(text, static_cast<std::size_t>(SysStringLen(text))))) {
        SysFreeString(text);
        return {ErrorCode::kUiaPasswordField, {},
                "masked password text is never read or captured"};
      }
      const auto text_utf8 = Utf16ToUtf8(text, static_cast<int>(SysStringLen(text)));
      if (HasNonWhitespace(text_utf8)) {
        if (!selection.text_utf8.empty()) selection.text_utf8.push_back('\n');
        selection.text_utf8 += text_utf8;
      }
    }
    if (text != nullptr) SysFreeString(text);
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
    }

    SafeArrayOwner rectangles;
    if (FAILED(range->GetBoundingRectangles(&rectangles.value)) || rectangles.value == nullptr) {
      continue;
    }
    if (CancelledOrExpired(stop_requested, deadline)) {
      return {ErrorCode::kUiaTimeout, {}, "UI Automation request deadline expired"};
    }
    LONG rect_lower = 0;
    LONG rect_upper = -1;
    if (FAILED(SafeArrayGetLBound(rectangles.value, 1, &rect_lower)) ||
        FAILED(SafeArrayGetUBound(rectangles.value, 1, &rect_upper))) {
      continue;
    }
    const auto raw_value_count = static_cast<std::int64_t>(rect_upper) -
                                 static_cast<std::int64_t>(rect_lower) + 1;
    if (raw_value_count < 4 || selection.bounds.size() >= 256U) continue;

    double* values = nullptr;
    const auto access_hr =
        SafeArrayAccessData(rectangles.value, reinterpret_cast<void**>(&values));
    if (FAILED(access_hr)) {
      continue;
    }
    if (values == nullptr) {
      SafeArrayUnaccessData(rectangles.value);
      continue;
    }
    const auto remaining_rectangle_count = 256U - selection.bounds.size();
    const auto value_count = static_cast<std::size_t>(std::min<std::int64_t>(
        raw_value_count, static_cast<std::int64_t>(remaining_rectangle_count * 4U)));
    for (std::size_t value_index = 0; value_index + 3U < value_count;
         value_index += 4U) {
      const double x = values[value_index];
      const double y = values[value_index + 1];
      const double width = values[value_index + 2];
      const double height = values[value_index + 3];
      const double right_edge = x + width;
      const double bottom_edge = y + height;
      if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) ||
          !std::isfinite(height) || !std::isfinite(right_edge) ||
          !std::isfinite(bottom_edge) || width <= 0.0 || height <= 0.0 ||
          x < static_cast<double>(std::numeric_limits<std::int32_t>::min()) ||
          y < static_cast<double>(std::numeric_limits<std::int32_t>::min()) ||
          right_edge > static_cast<double>(std::numeric_limits<std::int32_t>::max()) ||
          bottom_edge > static_cast<double>(std::numeric_limits<std::int32_t>::max())) {
        continue;
      }
      const auto left = static_cast<std::int32_t>(std::floor(x));
      const auto top = static_cast<std::int32_t>(std::floor(y));
      const auto right = static_cast<std::int32_t>(std::ceil(right_edge));
      const auto bottom = static_cast<std::int32_t>(std::ceil(bottom_edge));
      const auto bounded_width = static_cast<std::int64_t>(right) - left;
      const auto bounded_height = static_cast<std::int64_t>(bottom) - top;
      if (bounded_width <= 0 || bounded_height <= 0 ||
          bounded_width > std::numeric_limits<std::int32_t>::max() ||
          bounded_height > std::numeric_limits<std::int32_t>::max()) {
        continue;
      }
      selection.bounds.push_back(
          {left, top, static_cast<std::int32_t>(bounded_width),
           static_cast<std::int32_t>(bounded_height)});
    }
    SafeArrayUnaccessData(rectangles.value);
  }

  if (!HasNonWhitespace(selection.text_utf8)) {
    return {ErrorCode::kUiaNoSelection, {}, "selection is empty or collapsed"};
  }
  return {ErrorCode::kOk, std::move(selection), {}};
}

}  // namespace

UiaWorker::UiaWorker() = default;

UiaWorker::~UiaWorker() { Stop(); }

bool UiaWorker::Start() {
  if (thread_.joinable()) return available();
  stop_requested_.store(false, std::memory_order_release);
  std::promise<bool> started;
  auto ready = started.get_future();
  thread_ = std::thread(&UiaWorker::ThreadMain, this, std::move(started));
  return ready.get();
}

void UiaWorker::Stop() noexcept {
  stop_requested_.store(true, std::memory_order_release);
  condition_.notify_all();
  if (thread_.joinable()) {
    // This is a dedicated, stateless helper process. A defective third-party
    // provider must not keep it orphaned forever after shutdown. Normal UIA
    // calls are bounded by IUIAutomation2 above; this is the final fail-safe.
    const auto thread_handle = reinterpret_cast<HANDLE>(thread_.native_handle());
    if (WaitForSingleObject(thread_handle, 3500U) != WAIT_OBJECT_0) {
      TerminateProcess(GetCurrentProcess(), ERROR_TIMEOUT);
      return;
    }
    thread_.join();
  }
  available_.store(false, std::memory_order_release);
}

std::optional<std::future<SelectionResult>> UiaWorker::TryGetSelection(
    PhysicalPoint point, std::uint32_t timeout_ms) {
  std::lock_guard lock(mutex_);
  if (stop_requested_.load(std::memory_order_acquire) || outstanding_ || timeout_ms == 0U) {
    return std::nullopt;
  }
  Request request;
  request.point = point;
  request.timeout_ms = timeout_ms;
  auto future = request.completion.get_future();
  request_ = std::move(request);
  outstanding_ = true;
  condition_.notify_one();
  return future;
}

void UiaWorker::ThreadMain(std::promise<bool> started) noexcept {
  const auto com_hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(com_hr);
  ComPtr<IUIAutomation> automation;
  const bool initialized = com_initialized &&
      SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER,
                                 IID_PPV_ARGS(&automation)));
  if (initialized) {
    ComPtr<IUIAutomation2> automation2;
    if (SUCCEEDED(automation.As(&automation2)) && automation2) {
      // UIA's default transaction timeout is much longer than our selection
      // deadline. Bound provider calls so normal host shutdown remains finite.
      (void)automation2->put_ConnectionTimeout(2000U);
      (void)automation2->put_TransactionTimeout(2000U);
    }
  }
  available_.store(initialized, std::memory_order_release);
  started.set_value(initialized);

  for (;;) {
    std::optional<Request> request;
    bool stopping = false;
    {
      std::unique_lock lock(mutex_);
      condition_.wait(lock, [this] {
        return stop_requested_.load(std::memory_order_acquire) || request_.has_value();
      });
      if (stop_requested_.load(std::memory_order_acquire)) {
        request = std::move(request_);
        request_.reset();
        outstanding_ = false;
        stopping = true;
      } else {
        request = std::move(request_);
        request_.reset();
      }
    }
    if (stopping) {
      if (request) {
        request->completion.set_value(
            {ErrorCode::kInvalidState, {}, "UI Automation worker is stopping"});
      }
      break;
    }

    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(request->timeout_ms);
    SelectionResult result;
    try {
      result = initialized
          ? ReadSelection(automation.Get(), request->point, stop_requested_, deadline)
          : SelectionResult{ErrorCode::kUiaUnavailable, {},
                            "UI Automation initialization failed"};
    } catch (...) {
      result = {ErrorCode::kInternalError, {}, "UI Automation worker raised an exception"};
    }
    try {
      request->completion.set_value(std::move(result));
    } catch (...) {
      // The requester may have been destroyed during shutdown. The worker can
      // still complete its state transition and exit safely.
    }
    {
      std::lock_guard lock(mutex_);
      outstanding_ = false;
    }
  }

  automation.Reset();
  if (com_initialized) CoUninitialize();
}

}  // namespace desktop_translate::native
