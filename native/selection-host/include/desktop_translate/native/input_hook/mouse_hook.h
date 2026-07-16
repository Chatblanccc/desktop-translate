#pragma once

#include <Windows.h>

#include <atomic>
#include <cstdint>
#include <future>
#include <thread>

#include "desktop_translate/native/core/bounded_spsc_queue.h"
#include "desktop_translate/native/core/types.h"

namespace desktop_translate::native {

enum class MouseEventKind : std::uint8_t { kLeftDown, kMove, kLeftUp };

struct MouseEvent {
  MouseEventKind kind{MouseEventKind::kMove};
  PhysicalPoint point;
  std::uint64_t tick_ms{};
  bool injected{false};
  bool alt_down{false};
  std::uint64_t generation{};
};

class MouseHook {
 public:
  MouseHook();
  ~MouseHook();
  MouseHook(const MouseHook&) = delete;
  MouseHook& operator=(const MouseHook&) = delete;

  [[nodiscard]] bool Start();
  void Stop() noexcept;
  [[nodiscard]] bool WaitAndPop(MouseEvent& event, std::uint32_t timeout_ms) noexcept;
  void WakeConsumer() noexcept;
  // Call only while the Hook and selection consumer are both stopped.
  void DiscardPendingEvents() noexcept;

  [[nodiscard]] std::uint64_t dropped_event_count() const noexcept {
    return dropped_event_count_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t latest_generation() const noexcept {
    return latest_generation_.load(std::memory_order_acquire);
  }

 private:
  static LRESULT CALLBACK HookProcedure(int code, WPARAM message, LPARAM data) noexcept;
  void ThreadMain(std::promise<bool> started) noexcept;
  void OnHookEvent(WPARAM message, const MSLLHOOKSTRUCT& data) noexcept;

  static std::atomic<MouseHook*> active_instance_;
  BoundedSpscQueue<MouseEvent, 1024> queue_;
  std::atomic<std::uint64_t> dropped_event_count_{0};
  std::atomic<std::uint64_t> latest_generation_{0};
  HANDLE queue_event_{nullptr};
  std::thread thread_;
  std::atomic<DWORD> thread_id_{0};
  std::atomic<bool> running_{false};
};

}  // namespace desktop_translate::native
