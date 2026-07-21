#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <utility>

#include "desktop_translate/native/core/envelope.h"

namespace desktop_translate::native {

// Assigns an event sequence and writes the corresponding frame under one lock.
// Keeping both operations in the same critical section prevents concurrently
// produced events from reaching the pipe in a different order than their seq.
class SequencedEventWriter {
 public:
  using SendSink = std::function<bool(const Envelope&)>;

  explicit SequencedEventWriter(SendSink send_sink)
      : send_sink_(std::move(send_sink)) {}

  SequencedEventWriter(const SequencedEventWriter&) = delete;
  SequencedEventWriter& operator=(const SequencedEventWriter&) = delete;

  [[nodiscard]] bool Send(std::string method, std::string timestamp,
                          std::string payload_json) noexcept {
    try {
      std::lock_guard lock(send_mutex_);
      const auto sequence = next_sequence_++;
      Envelope event;
      event.kind = MessageKind::kEvent;
      event.sequence = sequence;
      event.method = std::move(method);
      event.timestamp = std::move(timestamp);
      event.payload_json = std::move(payload_json);
      if (!send_sink_ || !send_sink_(event)) return false;
      last_sequence_.store(sequence, std::memory_order_release);
      return true;
    } catch (...) {
      return false;
    }
  }

  [[nodiscard]] std::uint64_t last_sequence() const noexcept {
    return last_sequence_.load(std::memory_order_acquire);
  }

 private:
  SendSink send_sink_;
  std::mutex send_mutex_;
  std::uint64_t next_sequence_{0};
  std::atomic<std::uint64_t> last_sequence_{0};
};

}  // namespace desktop_translate::native
