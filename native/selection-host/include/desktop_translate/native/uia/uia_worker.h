#pragma once

#include <condition_variable>
#include <atomic>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>

#include "desktop_translate/native/core/types.h"

namespace desktop_translate::native {

class UiaWorker {
 public:
  UiaWorker();
  ~UiaWorker();
  UiaWorker(const UiaWorker&) = delete;
  UiaWorker& operator=(const UiaWorker&) = delete;

  // Returns whether UI Automation initialized. A false return does not prevent
  // the host from running its OCR fallback.
  [[nodiscard]] bool Start();
  void Stop() noexcept;
  [[nodiscard]] std::optional<std::future<SelectionResult>> TryGetSelection(
      PhysicalPoint point, std::uint32_t timeout_ms);
  [[nodiscard]] bool available() const noexcept {
    return available_.load(std::memory_order_acquire);
  }

 private:
  struct Request {
    PhysicalPoint point;
    std::uint32_t timeout_ms{350U};
    std::promise<SelectionResult> completion;
  };

  void ThreadMain(std::promise<bool> started) noexcept;

  std::mutex mutex_;
  std::condition_variable condition_;
  std::optional<Request> request_;
  std::thread thread_;
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> available_{false};
  bool outstanding_{false};
};

}  // namespace desktop_translate::native
