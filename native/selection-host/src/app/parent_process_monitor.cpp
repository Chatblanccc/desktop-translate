#include "desktop_translate/native/app/parent_process_monitor.h"

#include <utility>

namespace desktop_translate::native {

ParentProcessMonitor::~ParentProcessMonitor() { Stop(); }

bool ParentProcessMonitor::Start(std::uint32_t parent_pid, std::function<void()> on_exit) {
  if (parent_ != nullptr || parent_pid == 0U || !on_exit) return false;
  parent_ = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
  if (parent_ == nullptr) return false;
  stop_requested_.store(false, std::memory_order_release);
  try {
    thread_ = std::thread([this, callback = std::move(on_exit)] {
      while (!stop_requested_.load(std::memory_order_acquire)) {
        const auto wait = WaitForSingleObject(parent_, 250U);
        if (wait == WAIT_OBJECT_0) {
          callback();
          return;
        }
        if (wait == WAIT_FAILED) return;
      }
    });
  } catch (...) {
    CloseHandle(parent_);
    parent_ = nullptr;
    return false;
  }
  return true;
}

void ParentProcessMonitor::Stop() noexcept {
  stop_requested_.store(true, std::memory_order_release);
  if (thread_.joinable()) thread_.join();
  if (parent_ != nullptr) {
    CloseHandle(parent_);
    parent_ = nullptr;
  }
}

}  // namespace desktop_translate::native
