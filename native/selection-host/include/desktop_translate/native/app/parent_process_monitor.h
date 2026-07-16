#pragma once

#include <Windows.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <thread>

namespace desktop_translate::native {

class ParentProcessMonitor {
 public:
  ParentProcessMonitor() = default;
  ~ParentProcessMonitor();
  ParentProcessMonitor(const ParentProcessMonitor&) = delete;
  ParentProcessMonitor& operator=(const ParentProcessMonitor&) = delete;

  [[nodiscard]] bool Start(std::uint32_t parent_pid, std::function<void()> on_exit);
  void Stop() noexcept;

 private:
  HANDLE parent_{nullptr};
  std::thread thread_;
  std::atomic<bool> stop_requested_{false};
};

}  // namespace desktop_translate::native
