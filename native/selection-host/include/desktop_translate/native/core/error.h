#pragma once

#include <string_view>

namespace desktop_translate::native {

enum class ErrorCode {
  kOk,
  kInvalidArgument,
  kFrameTooLarge,
  kMalformedFrame,
  kMalformedJson,
  kUnsupportedProtocol,
  kHandshakeRequired,
  kNonceMismatch,
  kUnauthorizedClient,
  kInvalidState,
  kPipeError,
  kParentExited,
  kHookInstallFailed,
  kHookQueueOverflow,
  kSelectionCancelled,
  kTargetElevated,
  kSecureDesktop,
  kProtectedContent,
  kUiaUnavailable,
  kUiaPasswordField,
  kUiaNoSelection,
  kUiaTimeout,
  kCaptureUnavailable,
  kCaptureTimeout,
  kCaptureAccessLost,
  kCaptureProtected,
  kCrossMonitorUnsupported,
  kOcrUnavailable,
  kOcrTimeout,
  kOcrNoText,
  kOcrLowConfidence,
  kInternalError,
};

[[nodiscard]] constexpr std::string_view ToString(ErrorCode code) noexcept {
  switch (code) {
    case ErrorCode::kOk: return "ok";
    case ErrorCode::kInvalidArgument: return "invalid_argument";
    case ErrorCode::kFrameTooLarge: return "frame_too_large";
    case ErrorCode::kMalformedFrame: return "malformed_frame";
    case ErrorCode::kMalformedJson: return "malformed_json";
    case ErrorCode::kUnsupportedProtocol: return "unsupported_protocol";
    case ErrorCode::kHandshakeRequired: return "handshake_required";
    case ErrorCode::kNonceMismatch: return "nonce_mismatch";
    case ErrorCode::kUnauthorizedClient: return "unauthorized_client";
    case ErrorCode::kInvalidState: return "invalid_state";
    case ErrorCode::kPipeError: return "pipe_error";
    case ErrorCode::kParentExited: return "parent_exited";
    case ErrorCode::kHookInstallFailed: return "hook_install_failed";
    case ErrorCode::kHookQueueOverflow: return "hook_queue_overflow";
    case ErrorCode::kSelectionCancelled: return "selection_cancelled";
    case ErrorCode::kTargetElevated: return "target_elevated";
    case ErrorCode::kSecureDesktop: return "secure_desktop";
    case ErrorCode::kProtectedContent: return "protected_content";
    case ErrorCode::kUiaUnavailable: return "uia_unavailable";
    case ErrorCode::kUiaPasswordField: return "uia_password_field";
    case ErrorCode::kUiaNoSelection: return "uia_no_selection";
    case ErrorCode::kUiaTimeout: return "uia_timeout";
    case ErrorCode::kCaptureUnavailable: return "capture_unavailable";
    case ErrorCode::kCaptureTimeout: return "capture_timeout";
    case ErrorCode::kCaptureAccessLost: return "capture_access_lost";
    case ErrorCode::kCaptureProtected: return "capture_protected";
    case ErrorCode::kCrossMonitorUnsupported: return "cross_monitor_unsupported";
    case ErrorCode::kOcrUnavailable: return "ocr_unavailable";
    case ErrorCode::kOcrTimeout: return "ocr_timeout";
    case ErrorCode::kOcrNoText: return "ocr_no_text";
    case ErrorCode::kOcrLowConfidence: return "ocr_low_confidence";
    case ErrorCode::kInternalError: return "internal_error";
  }
  return "internal_error";
}

}  // namespace desktop_translate::native
