#pragma once

#include <mutex>
#include <string_view>

#include "desktop_translate/native/core/error.h"

namespace desktop_translate::native {

enum class HostState { kStopped, kRunning, kShuttingDown };

[[nodiscard]] constexpr std::string_view ToString(HostState state) noexcept {
  switch (state) {
    case HostState::kStopped: return "stopped";
    case HostState::kRunning: return "running";
    case HostState::kShuttingDown: return "shutting_down";
  }
  return "shutting_down";
}

struct TransitionResult {
  ErrorCode error{ErrorCode::kOk};
  HostState before{HostState::kStopped};
  HostState after{HostState::kStopped};
  bool changed{false};
};

class HostStateMachine {
 public:
  [[nodiscard]] TransitionResult Start() noexcept;
  [[nodiscard]] TransitionResult Stop() noexcept;
  [[nodiscard]] TransitionResult Shutdown() noexcept;
  [[nodiscard]] HostState state() const noexcept;

 private:
  mutable std::mutex mutex_;
  HostState state_{HostState::kStopped};
};

}  // namespace desktop_translate::native
