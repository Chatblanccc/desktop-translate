#include "desktop_translate/native/app/selection_host_app.h"

#include <Windows.h>
#include <ShellScalingApi.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <iomanip>
#include <iterator>
#include <limits>
#include <locale>
#include <sstream>
#include <string_view>
#include <unordered_set>
#include <utility>

#include "desktop_translate/native/coordinates/coordinates.h"
#include "desktop_translate/native/core/envelope.h"
#include "desktop_translate/native/core/security.h"
#include "desktop_translate/native/core/utf8.h"
#include "desktop_translate/native/ocr/windows_ocr_adapter.h"
#include "desktop_translate/native/ocr/paddle_ocr_adapter.h"

namespace desktop_translate::native {
namespace {

#ifndef DT_PRODUCT_VERSION
#error "DT_PRODUCT_VERSION must be supplied by the Native build"
#endif
constexpr std::string_view kHostVersion = DT_PRODUCT_VERSION;

std::string UtcTimestamp() {
  SYSTEMTIME time{};
  GetSystemTime(&time);
  char value[32]{};
  std::snprintf(value, sizeof(value), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                static_cast<unsigned int>(time.wYear),
                static_cast<unsigned int>(time.wMonth),
                static_cast<unsigned int>(time.wDay),
                static_cast<unsigned int>(time.wHour),
                static_cast<unsigned int>(time.wMinute),
                static_cast<unsigned int>(time.wSecond),
                static_cast<unsigned int>(time.wMilliseconds));
  return value;
}

std::string JsonString(std::string_view value) {
  return "\"" + EscapeJsonString(value) + "\"";
}

std::string BoolJson(bool value) { return value ? "true" : "false"; }

std::string NumberJson(double value) {
  std::ostringstream output;
  output.imbue(std::locale::classic());
  output << std::setprecision(10) << value;
  return output.str();
}

std::string RectJson(PhysicalRect rect) {
  return "{\"x\":" + std::to_string(rect.x) + ",\"y\":" + std::to_string(rect.y) +
         ",\"width\":" + std::to_string(rect.width) +
         ",\"height\":" + std::to_string(rect.height) + "}";
}

std::string RectArrayJson(const std::vector<PhysicalRect>& rectangles) {
  std::string json = "[";
  bool first = true;
  for (const auto rect : rectangles) {
    if (rect.IsEmpty()) continue;
    if (!first) json.push_back(',');
    first = false;
    json += RectJson(rect);
  }
  json.push_back(']');
  return json;
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
  if ((first_wide.empty() && !first.empty()) || (second_wide.empty() && !second.empty())) {
    return false;
  }
  return CompareStringOrdinal(first_wide.data(), static_cast<int>(first_wide.size()),
                              second_wide.data(), static_cast<int>(second_wide.size()), TRUE) ==
         CSTR_EQUAL;
}

bool IsWindowsBasename(std::string_view value) {
  if (value.empty() || Utf16CodeUnitLength(value) > 260U || value == "." || value == ".." ||
      value.ends_with('.') || value.ends_with(' ')) {
    return false;
  }
  constexpr std::string_view kForbidden = "<>:\"/\\|?*";
  return std::none_of(value.begin(), value.end(), [](unsigned char c) {
    return c <= 0x1fU;
  }) && std::none_of(value.begin(), value.end(), [&](char c) {
    return kForbidden.find(c) != std::string_view::npos;
  });
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
  return TruncateUtf8ToUtf16Units(
      Utf16ToUtf8(slash == std::wstring::npos
                      ? std::wstring_view(path)
                      : std::wstring_view(path).substr(slash + 1U)),
      260U);
}

struct MonitorSnapshot {
  std::string id{"virtual-desktop"};
  std::uintptr_t handle{};
  PhysicalRect bounds{VirtualDesktopBounds()};
  PhysicalRect work_area{VirtualDesktopBounds()};
  UINT dpi_x{96U};
  UINT dpi_y{96U};
};

MonitorSnapshot MonitorAtPoint(PhysicalPoint point) {
  MonitorSnapshot snapshot;
  const POINT win32_point{point.x, point.y};
  const auto monitor = MonitorFromPoint(win32_point, MONITOR_DEFAULTTONEAREST);
  if (monitor == nullptr) return snapshot;

  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (GetMonitorInfoW(monitor, &info)) {
    snapshot.id = Utf16ToUtf8(info.szDevice);
    snapshot.handle = reinterpret_cast<std::uintptr_t>(monitor);
    snapshot.bounds = {info.rcMonitor.left, info.rcMonitor.top,
                       info.rcMonitor.right - info.rcMonitor.left,
                       info.rcMonitor.bottom - info.rcMonitor.top};
    snapshot.work_area = {info.rcWork.left, info.rcWork.top,
                          info.rcWork.right - info.rcWork.left,
                          info.rcWork.bottom - info.rcWork.top};
  }
  UINT dpi_x = 96U;
  UINT dpi_y = 96U;
  if (SUCCEEDED(GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &dpi_x, &dpi_y))) {
    snapshot.dpi_x = dpi_x >= 48U && dpi_x <= 768U ? dpi_x : 96U;
    snapshot.dpi_y = dpi_y >= 48U && dpi_y <= 768U ? dpi_y : 96U;
  }
  return snapshot;
}

std::string MonitorJson(const MonitorSnapshot& monitor) {
  return "{\"id\":" + JsonString(monitor.id) +
         ",\"handle\":" + JsonString(std::to_string(monitor.handle)) +
         ",\"bounds\":" + RectJson(monitor.bounds) +
         ",\"workArea\":" + RectJson(monitor.work_area) +
         ",\"dpiX\":" + std::to_string(monitor.dpi_x) +
         ",\"dpiY\":" + std::to_string(monitor.dpi_y) +
         ",\"scaleFactor\":" + NumberJson(static_cast<double>(monitor.dpi_x) / 96.0) + "}";
}

std::string UpperErrorCode(ErrorCode error) {
  std::string value(ToString(error));
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::toupper(c));
  });
  return value;
}

std::string StringArrayJson(const std::vector<std::string>& values) {
  std::string json = "[";
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index != 0U) json.push_back(',');
    json += JsonString(values[index]);
  }
  json.push_back(']');
  return json;
}

std::string EffectiveConfigJson(const SelectionPipelineConfig& config) {
  return "{\"enableUia\":" + BoolJson(config.enable_uia) +
         ",\"enableOcrFallback\":" + BoolJson(config.enable_ocr_fallback) +
         ",\"ocrActivation\":" +
         JsonString(config.ocr_requires_alt_drag ? "alt-drag" : "fallback") +
         ",\"settleDelayMs\":" + std::to_string(config.settle_delay_ms) +
         ",\"minDragDistancePx\":" + NumberJson(config.minimum_drag_distance_px) +
         ",\"uiaTimeoutMs\":" + std::to_string(config.uia_timeout_ms) +
         ",\"ocrTimeoutMs\":" + std::to_string(config.ocr_timeout_ms) +
         ",\"excludedProcessNames\":" + StringArrayJson(config.excluded_process_names) + "}";
}

std::optional<SelectionPipelineConfig> ParseConfig(std::string_view payload) {
  static constexpr std::string_view kAllowedFields[] = {
      "enableUia", "enableOcrFallback", "ocrActivation", "settleDelayMs",
      "minDragDistancePx", "uiaTimeoutMs", "ocrTimeoutMs", "excludedProcessNames"};
  if (!JsonObjectHasOnlyFields(payload, kAllowedFields)) return std::nullopt;
  SelectionPipelineConfig config;
  if (JsonObjectHasField(payload, "enableUia")) {
    const auto value = FindJsonBoolField(payload, "enableUia");
    if (!value) return std::nullopt;
    config.enable_uia = *value;
  }
  if (JsonObjectHasField(payload, "enableOcrFallback")) {
    const auto value = FindJsonBoolField(payload, "enableOcrFallback");
    if (!value) return std::nullopt;
    config.enable_ocr_fallback = *value;
  }
  if (JsonObjectHasField(payload, "ocrActivation")) {
    const auto value = FindJsonStringField(payload, "ocrActivation");
    if (!value || (*value != "fallback" && *value != "alt-drag")) return std::nullopt;
    config.ocr_requires_alt_drag = *value == "alt-drag";
  }
  if (JsonObjectHasField(payload, "settleDelayMs")) {
    const auto value = FindJsonUnsignedField(payload, "settleDelayMs");
    if (!value) return std::nullopt;
    config.settle_delay_ms = *value > std::numeric_limits<std::uint32_t>::max()
                                 ? std::numeric_limits<std::uint32_t>::max()
                                 : static_cast<std::uint32_t>(*value);
  }
  if (JsonObjectHasField(payload, "minDragDistancePx")) {
    const auto value = FindJsonNumberField(payload, "minDragDistancePx");
    if (!value) return std::nullopt;
    config.minimum_drag_distance_px = *value;
  }
  if (JsonObjectHasField(payload, "uiaTimeoutMs")) {
    const auto value = FindJsonUnsignedField(payload, "uiaTimeoutMs");
    if (!value) return std::nullopt;
    config.uia_timeout_ms = *value > std::numeric_limits<std::uint32_t>::max()
                                ? std::numeric_limits<std::uint32_t>::max()
                                : static_cast<std::uint32_t>(*value);
  }
  if (JsonObjectHasField(payload, "ocrTimeoutMs")) {
    const auto value = FindJsonUnsignedField(payload, "ocrTimeoutMs");
    if (!value) return std::nullopt;
    config.ocr_timeout_ms = *value > std::numeric_limits<std::uint32_t>::max()
                                ? std::numeric_limits<std::uint32_t>::max()
                                : static_cast<std::uint32_t>(*value);
  }
  if (JsonObjectHasField(payload, "excludedProcessNames")) {
    const auto value = FindJsonStringArrayField(payload, "excludedProcessNames");
    if (!value) return std::nullopt;
    config.excluded_process_names = *value;
  }
  if (config.excluded_process_names.size() > 256U) return std::nullopt;
  for (std::size_t index = 0; index < config.excluded_process_names.size(); ++index) {
    const auto& name = config.excluded_process_names[index];
    if (!IsWindowsBasename(name)) return std::nullopt;
    for (std::size_t previous = 0; previous < index; ++previous) {
      if (WindowsCaseInsensitiveEquals(name, config.excluded_process_names[previous])) {
        return std::nullopt;
      }
    }
  }
  return config;
}

bool IsValidConfig(const SelectionPipelineConfig& config) {
  return std::isfinite(config.minimum_drag_distance_px) &&
         config.settle_delay_ms <= 500U && config.minimum_drag_distance_px >= 2.0 &&
         config.minimum_drag_distance_px <= 64.0 && config.uia_timeout_ms >= 50U &&
         config.uia_timeout_ms <= 2000U && config.ocr_timeout_ms >= 250U &&
         config.ocr_timeout_ms <= 10000U;
}

bool ValidateOptionalString(std::string_view payload, std::string_view field,
                            std::size_t maximum_utf16_units) {
  if (!JsonObjectHasField(payload, field)) return true;
  const auto value = FindJsonStringField(payload, field);
  return value && Utf16CodeUnitLength(*value) <= maximum_utf16_units;
}

bool ValidateRequestedCapabilities(std::string_view payload) {
  if (!JsonObjectHasField(payload, "requestedCapabilities")) return true;
  const auto capabilities = FindJsonStringArrayField(payload, "requestedCapabilities");
  if (!capabilities) return false;
  static constexpr std::string_view kAllowed[] = {
      "mouse-hook", "uia-selection", "uia-point-approximation", "desktop-capture", "ocr"};
  std::unordered_set<std::string> unique;
  return std::all_of(capabilities->begin(), capabilities->end(), [&](const std::string& item) {
    return std::find(std::begin(kAllowed), std::end(kAllowed), item) != std::end(kAllowed) &&
           unique.insert(item).second;
  });
}

}  // namespace

SelectionHostApp::SelectionHostApp(SelectionHostOptions options)
    : options_(std::move(options)),
      pipe_server_(options_.pipe_name, options_.parent_pid),
      ocr_engine_(CreateWindowsOcrAdapter()) {
  pipeline_ = std::make_unique<SelectionPipeline>(
      mouse_hook_, uia_worker_, capture_, *ocr_engine_,
      [this](SelectionPipelineResult result) { HandlePipelineResult(std::move(result)); });
}

SelectionHostApp::~SelectionHostApp() {
  StopListening();
  uia_worker_.Stop();
}

int SelectionHostApp::Run() {
  started_tick_ms_ = GetTickCount64();
  (void)uia_worker_.Start();

  // Orphan prevention is intentionally fail-closed. The host stores no durable
  // data, so immediate termination after the parent exits is safer than hanging
  // forever in a third-party UIA provider during graceful teardown.
  if (!parent_monitor_.Start(options_.parent_pid, [] {
        TerminateProcess(GetCurrentProcess(), ERROR_PROCESS_ABORTED);
      })) {
    return 20;
  }

  const auto result = pipe_server_.Run(
      [this](const Envelope& envelope) { return HandleRequest(envelope); });
  StopListening();
  (void)state_.Shutdown();
  uia_worker_.Stop();
  parent_monitor_.Stop();
  return result == ErrorCode::kOk ? 0 : 21;
}

bool SelectionHostApp::HandleRequest(const Envelope& envelope) {
  if (envelope.kind != MessageKind::kRequest || !envelope.id) {
    SendError(ErrorCode::kMalformedJson, "protocol",
              "client messages must be request envelopes with an id");
    return false;
  }

  if (!handshake_complete_.load(std::memory_order_acquire)) {
    if (envelope.method != "hello") {
      SendError(ErrorCode::kHandshakeRequired, "protocol", "hello must be the first request",
                envelope.id);
      return false;
    }
    static constexpr std::string_view kHelloFields[] = {
        "desktopVersion", "supportedVersions", "sessionNonce", "requestedCapabilities"};
    if (!JsonObjectHasOnlyFields(envelope.payload_json, kHelloFields)) {
      SendError(ErrorCode::kMalformedJson, "protocol", "unknown hello payload field",
                envelope.id);
      return false;
    }
    if (!ValidateRequestedCapabilities(envelope.payload_json)) {
      SendError(ErrorCode::kMalformedJson, "protocol",
                "requestedCapabilities must be unique known capability names", envelope.id);
      return false;
    }
    const auto nonce = FindJsonStringField(envelope.payload_json, "sessionNonce");
    const auto desktop_version = FindJsonStringField(envelope.payload_json, "desktopVersion");
    const auto supported_versions =
        FindJsonUnsignedArrayField(envelope.payload_json, "supportedVersions");
    if (!nonce || !ConstantTimeEquals(*nonce, options_.session_nonce)) {
      SendError(ErrorCode::kNonceMismatch, "protocol", "session nonce mismatch", envelope.id);
      return false;
    }
    if (!desktop_version || desktop_version->empty() ||
        Utf16CodeUnitLength(*desktop_version) > 64U) {
      SendError(ErrorCode::kMalformedJson, "protocol", "desktopVersion is required", envelope.id);
      return false;
    }
    if (!supported_versions || supported_versions->size() != 1U ||
        (*supported_versions)[0] != 1U) {
      SendError(ErrorCode::kUnsupportedProtocol, "protocol",
                "supportedVersions must contain protocol v1", envelope.id);
      return false;
    }
    handshake_complete_.store(true, std::memory_order_release);
    const auto payload = "{\"selectedVersion\":1,\"hostVersion\":" +
                         JsonString(kHostVersion) + ",\"hostPid\":" +
                         JsonString(std::to_string(GetCurrentProcessId())) +
                         ",\"sessionNonce\":" + JsonString(options_.session_nonce) +
                         ",\"capabilities\":" + CapabilitiesJson() + "}";
    return SendResponse(envelope, "ready", payload);
  }

  if (envelope.method == "hello") {
    SendError(ErrorCode::kInvalidState, "protocol", "hello may only be sent once", envelope.id);
    return false;
  }
  if (envelope.method == "health") {
    static constexpr std::array<std::string_view, 0> kNoFields{};
    if (!JsonObjectHasOnlyFields(envelope.payload_json, kNoFields)) {
      SendError(ErrorCode::kMalformedJson, "protocol", "health payload must be empty",
                envelope.id);
      return true;
    }
    const auto host_state = state_.state();
    const bool listening = host_state == HostState::kRunning && mouse_hook_.installed() &&
                           pipeline_ && pipeline_->running();
    const bool degraded = !uia_worker_.available() || !ocr_engine_->available() ||
                          (host_state == HostState::kRunning && !listening);
    const std::string status = host_state == HostState::kShuttingDown
                                   ? "stopping"
                                   : (degraded ? "degraded" : "ready");
    const auto uptime = GetTickCount64() - started_tick_ms_;
    const auto payload = "{\"status\":" + JsonString(status) +
                         ",\"listening\":" + BoolJson(listening) +
                         ",\"uptimeMs\":" + std::to_string(uptime) +
                         ",\"lastEventSeq\":" +
                         std::to_string(last_event_sequence_.load(std::memory_order_acquire)) +
                         ",\"degradedCapabilities\":" + DegradedCapabilitiesJson() + "}";
    return SendResponse(envelope, "health", payload);
  }
  if (envelope.method == "start") return StartListening(envelope);
  if (envelope.method == "stop") {
    static constexpr std::string_view kStopFields[] = {"reason"};
    if (!JsonObjectHasOnlyFields(envelope.payload_json, kStopFields) ||
        !ValidateOptionalString(envelope.payload_json, "reason", 256U)) {
      SendError(ErrorCode::kMalformedJson, "protocol", "invalid stop payload", envelope.id);
      return true;
    }
    StopListening();
    (void)state_.Stop();
    return SendResponse(envelope, "stop", "{\"ok\":true,\"listening\":false}");
  }
  if (envelope.method == "shutdown") {
    static constexpr std::string_view kShutdownFields[] = {"reason", "gracePeriodMs"};
    const auto grace_period = FindJsonUnsignedField(envelope.payload_json, "gracePeriodMs");
    if (!JsonObjectHasOnlyFields(envelope.payload_json, kShutdownFields) ||
        !ValidateOptionalString(envelope.payload_json, "reason", 256U) ||
        (JsonObjectHasField(envelope.payload_json, "gracePeriodMs") &&
         (!grace_period || *grace_period > 5000U))) {
      SendError(ErrorCode::kMalformedJson, "protocol", "invalid shutdown payload", envelope.id);
      return true;
    }
    (void)state_.Shutdown();
    StopListening();
    (void)SendResponse(envelope, "shutdown", "{\"ok\":true}");
    return false;
  }

  SendError(ErrorCode::kInvalidArgument, "protocol", "unsupported request method", envelope.id);
  return true;
}

bool SelectionHostApp::StartListening(const Envelope& request) {
  if (state_.state() == HostState::kShuttingDown) {
    SendError(ErrorCode::kInvalidState, "host", "host is shutting down", request.id);
    return true;
  }
  // Validate every start request, including idempotent starts while already
  // running. A caller must never be able to smuggle unknown or out-of-range
  // configuration merely because the host has already started.
  auto requested_config = ParseConfig(request.payload_json);
  if (!requested_config || !IsValidConfig(*requested_config)) {
    SendError(ErrorCode::kInvalidArgument, "host", "invalid start configuration", request.id);
    return true;
  }
  if (state_.state() != HostState::kRunning) {
    if (!pipeline_->SetConfig(*requested_config)) {
      SendError(ErrorCode::kInvalidArgument, "host", "invalid start configuration", request.id);
      return true;
    }
    effective_config_ = std::move(*requested_config);
    if (!pipeline_->Start()) {
      SendError(ErrorCode::kInternalError, "host", "selection pipeline failed to start", request.id);
      return true;
    }
    if (!mouse_hook_.Start()) {
      pipeline_->Stop();
      SendError(ErrorCode::kHookInstallFailed, "hook", "WH_MOUSE_LL installation failed",
                request.id);
      return true;
    }
    (void)state_.Start();
  }

  const auto payload = "{\"ok\":true,\"listening\":true,\"effectiveConfig\":" +
                       EffectiveConfigJson(effective_config_) + "}";
  return SendResponse(request, "start", payload);
}

void SelectionHostApp::StopListening() noexcept {
  mouse_hook_.Stop();
  if (pipeline_) pipeline_->Stop();
}

bool SelectionHostApp::SendResponse(const Envelope& request, std::string method,
                                    std::string payload_json) noexcept {
  Envelope response;
  response.kind = MessageKind::kResponse;
  response.id = request.id;
  response.method = std::move(method);
  response.timestamp = UtcTimestamp();
  response.payload_json = std::move(payload_json);
  return pipe_server_.Send(response);
}

void SelectionHostApp::HandlePipelineResult(SelectionPipelineResult result) noexcept {
  if (!result.selection.ok() || (result.source != "uia" && result.source != "ocr")) {
    const auto error = result.selection.error == ErrorCode::kOk
                           ? (result.ocr_error != ErrorCode::kOk ? result.ocr_error
                                                                 : result.capture_error)
                           : result.selection.error;
    std::string scope = "host";
    if (error == ErrorCode::kUiaUnavailable || error == ErrorCode::kUiaNoSelection ||
        error == ErrorCode::kUiaTimeout || error == ErrorCode::kUiaPasswordField) scope = "uia";
    else if (error == ErrorCode::kCaptureUnavailable || error == ErrorCode::kCaptureTimeout ||
             error == ErrorCode::kCaptureAccessLost || error == ErrorCode::kCaptureProtected ||
             error == ErrorCode::kCrossMonitorUnsupported) {
      scope = "capture";
    } else if (error == ErrorCode::kOcrUnavailable || error == ErrorCode::kOcrTimeout ||
               error == ErrorCode::kOcrNoText || error == ErrorCode::kOcrLowConfidence) {
      scope = "ocr";
    }
    SendError(error, std::move(scope),
              result.selection.detail.empty() ? std::string(ToString(error))
                                              : result.selection.detail,
              {}, result.selection_id);
    return;
  }

  const auto timestamp = UtcTimestamp();
  const auto monitor = MonitorAtPoint(result.release_point);
  std::string target = "{\"pid\":" + JsonString(std::to_string(result.target_pid)) +
                       ",\"hwnd\":" + JsonString(std::to_string(result.target_hwnd));
  if (const auto process_name = ProcessBaseName(result.target_pid); !process_name.empty()) {
    target += ",\"processName\":" + JsonString(process_name);
  }
  target.push_back('}');

  const auto payload = "{\"selectionId\":" + JsonString(result.selection_id) +
                       ",\"source\":" + JsonString(result.source) +
                       ",\"text\":" + JsonString(result.selection.selection.text_utf8) +
                       ",\"ranges\":[{\"start\":0,\"end\":" +
                       std::to_string(Utf16CodeUnitLength(result.selection.selection.text_utf8)) +
                       ",\"text\":" + JsonString(result.selection.selection.text_utf8) +
                       ",\"physicalRects\":" +
                       RectArrayJson(result.selection.selection.bounds) + "}]" +
                       ",\"confidence\":" + NumberJson(result.confidence) +
                       ",\"physicalRects\":" +
                       RectArrayJson(result.selection.selection.bounds) +
                       ",\"releasePoint\":{\"x\":" +
                       std::to_string(result.release_point.x) + ",\"y\":" +
                       std::to_string(result.release_point.y) + "}" +
                       ",\"monitor\":" + MonitorJson(monitor) +
                       ",\"target\":" + target +
                       ",\"coordinateSpace\":\"physical-px\"" +
                       ",\"timestamp\":" + JsonString(timestamp) + "}";

  const auto sequence = next_event_sequence_.fetch_add(1U, std::memory_order_acq_rel);
  last_event_sequence_.store(sequence, std::memory_order_release);
  Envelope event;
  event.kind = MessageKind::kEvent;
  event.sequence = sequence;
  event.method = "selection/result";
  event.timestamp = timestamp;
  event.payload_json = payload;
  (void)pipe_server_.Send(event);
}

void SelectionHostApp::SendError(ErrorCode error, std::string scope, std::string message,
                                 std::optional<std::string> related_request_id,
                                 std::optional<std::string> selection_id) noexcept {
  const auto sequence = next_event_sequence_.fetch_add(1U, std::memory_order_acq_rel);
  last_event_sequence_.store(sequence, std::memory_order_release);
  const std::string_view raw_message =
      message.empty() ? ToString(error) : std::string_view(message);
  const auto bounded_message = TruncateUtf8ToUtf16Units(raw_message, 1024U);
  std::string payload = "{\"code\":" + JsonString(UpperErrorCode(error)) +
                        ",\"message\":" + JsonString(bounded_message) +
                        ",\"scope\":" + JsonString(scope) +
                        ",\"recoverable\":" +
                        BoolJson(error != ErrorCode::kNonceMismatch &&
                                 error != ErrorCode::kUnauthorizedClient &&
                                 error != ErrorCode::kUnsupportedProtocol);
  if (related_request_id) payload += ",\"relatedRequestId\":" + JsonString(*related_request_id);
  if (selection_id) payload += ",\"selectionId\":" + JsonString(*selection_id);
  payload.push_back('}');

  Envelope event;
  event.kind = MessageKind::kEvent;
  event.sequence = sequence;
  event.method = "host/error";
  event.timestamp = UtcTimestamp();
  event.payload_json = std::move(payload);
  (void)pipe_server_.Send(event);
}

std::string SelectionHostApp::CapabilitiesJson() const {
  std::vector<std::string> capabilities{"mouse-hook", "desktop-capture"};
  if (uia_worker_.available()) capabilities.emplace_back("uia-selection");
  if (ocr_engine_->available()) capabilities.emplace_back("ocr");
  return StringArrayJson(capabilities);
}

std::string SelectionHostApp::DegradedCapabilitiesJson() const {
  std::vector<std::string> capabilities;
  if (!uia_worker_.available()) capabilities.emplace_back("uia-selection");
  if (!ocr_engine_->available()) capabilities.emplace_back("ocr");
  if (state_.state() == HostState::kRunning && !mouse_hook_.installed()) {
    capabilities.emplace_back("mouse-hook");
  }
  return StringArrayJson(capabilities);
}

}  // namespace desktop_translate::native
