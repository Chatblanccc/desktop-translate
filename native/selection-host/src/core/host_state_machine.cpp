#include "desktop_translate/native/core/host_state_machine.h"

namespace desktop_translate::native {

TransitionResult HostStateMachine::Start() noexcept {
  std::lock_guard lock(mutex_);
  const auto before = state_;
  if (state_ == HostState::kShuttingDown) {
    return {ErrorCode::kInvalidState, before, state_, false};
  }
  if (state_ == HostState::kRunning) {
    return {ErrorCode::kOk, before, state_, false};
  }
  state_ = HostState::kRunning;
  return {ErrorCode::kOk, before, state_, true};
}

TransitionResult HostStateMachine::Stop() noexcept {
  std::lock_guard lock(mutex_);
  const auto before = state_;
  if (state_ == HostState::kShuttingDown) {
    return {ErrorCode::kInvalidState, before, state_, false};
  }
  if (state_ == HostState::kStopped) {
    return {ErrorCode::kOk, before, state_, false};
  }
  state_ = HostState::kStopped;
  return {ErrorCode::kOk, before, state_, true};
}

TransitionResult HostStateMachine::Shutdown() noexcept {
  std::lock_guard lock(mutex_);
  const auto before = state_;
  if (state_ == HostState::kShuttingDown) {
    return {ErrorCode::kOk, before, state_, false};
  }
  state_ = HostState::kShuttingDown;
  return {ErrorCode::kOk, before, state_, true};
}

HostState HostStateMachine::state() const noexcept {
  std::lock_guard lock(mutex_);
  return state_;
}

}  // namespace desktop_translate::native
