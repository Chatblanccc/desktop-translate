#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <type_traits>

namespace desktop_translate::native {

// One producer and one consumer only. Capacity is N - 1 so full and empty are
// distinguishable without locks. The hook callback is the sole producer.
template <typename T, std::size_t N>
class BoundedSpscQueue {
  static_assert(N >= 2, "queue must contain at least two slots");
  static_assert(std::is_nothrow_copy_assignable_v<T>,
                "hook events must be nothrow-copyable");

 public:
  [[nodiscard]] bool TryPush(const T& value) noexcept {
    const auto head = head_.load(std::memory_order_relaxed);
    const auto next = Increment(head);
    if (next == tail_.load(std::memory_order_acquire)) {
      return false;
    }
    slots_[head] = value;
    head_.store(next, std::memory_order_release);
    return true;
  }

  [[nodiscard]] bool TryPop(T& value) noexcept {
    const auto tail = tail_.load(std::memory_order_relaxed);
    if (tail == head_.load(std::memory_order_acquire)) {
      return false;
    }
    value = slots_[tail];
    tail_.store(Increment(tail), std::memory_order_release);
    return true;
  }

  [[nodiscard]] bool empty() const noexcept {
    return tail_.load(std::memory_order_acquire) ==
           head_.load(std::memory_order_acquire);
  }

 private:
  [[nodiscard]] static constexpr std::size_t Increment(std::size_t index) noexcept {
    return (index + 1U) % N;
  }

  std::array<T, N> slots_{};
  alignas(64) std::atomic<std::size_t> head_{0};
  alignas(64) std::atomic<std::size_t> tail_{0};
};

}  // namespace desktop_translate::native
