#pragma once

#include <Windows.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>

#include "desktop_translate/native/core/envelope.h"
#include "desktop_translate/native/core/error.h"

namespace desktop_translate::native {

class NamedPipeServer {
 public:
  using RequestHandler = std::function<bool(const Envelope&)>;

  NamedPipeServer(std::wstring pipe_name, std::uint32_t expected_client_pid);
  ~NamedPipeServer();
  NamedPipeServer(const NamedPipeServer&) = delete;
  NamedPipeServer& operator=(const NamedPipeServer&) = delete;

  // Blocks until the one authenticated client disconnects, the handler asks to
  // stop, or Stop() cancels the server thread.
  [[nodiscard]] ErrorCode Run(const RequestHandler& handler);
  [[nodiscard]] bool Send(const Envelope& envelope) noexcept;
  void Stop() noexcept;

  [[nodiscard]] bool connected() const noexcept {
    return connected_.load(std::memory_order_acquire);
  }

 private:
  void CloseHandles() noexcept;

  std::wstring pipe_name_;
  std::uint32_t expected_client_pid_{};
  mutable std::mutex handle_mutex_;
  std::mutex write_mutex_;
  HANDLE pipe_{INVALID_HANDLE_VALUE};
  HANDLE stop_event_{nullptr};
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> connected_{false};
};

}  // namespace desktop_translate::native
