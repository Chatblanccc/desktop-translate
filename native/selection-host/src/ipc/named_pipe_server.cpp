#include "desktop_translate/native/ipc/named_pipe_server.h"

#include <sddl.h>

#include <array>
#include <memory>
#include <span>
#include <utility>
#include <vector>

#include "desktop_translate/native/core/frame_codec.h"

namespace desktop_translate::native {
namespace {

struct LocalFreeDeleter {
  void operator()(void* value) const noexcept {
    if (value != nullptr) LocalFree(value);
  }
};

using LocalAllocation = std::unique_ptr<void, LocalFreeDeleter>;

struct HandleCloser {
  void operator()(void* value) const noexcept {
    if (value != nullptr && value != INVALID_HANDLE_VALUE) CloseHandle(value);
  }
};

using UniqueHandle = std::unique_ptr<void, HandleCloser>;

enum class IoStatus { kCompleted, kStopped, kTimedOut, kFailed };

struct IoCompletion {
  IoStatus status{IoStatus::kFailed};
  DWORD transferred{};
  DWORD error{};
};

IoCompletion WaitForPendingIo(HANDLE pipe, OVERLAPPED& operation, HANDLE stop_event,
                              DWORD timeout_ms) {
  const HANDLE waits[] = {operation.hEvent, stop_event};
  const auto wait = WaitForMultipleObjects(2U, waits, FALSE, timeout_ms);
  if (wait == WAIT_OBJECT_0) {
    DWORD transferred = 0;
    if (GetOverlappedResult(pipe, &operation, &transferred, FALSE)) {
      return {IoStatus::kCompleted, transferred, ERROR_SUCCESS};
    }
    return {IoStatus::kFailed, 0U, GetLastError()};
  }

  const auto status = wait == WAIT_OBJECT_0 + 1U ? IoStatus::kStopped
                                                  : (wait == WAIT_TIMEOUT ? IoStatus::kTimedOut
                                                                          : IoStatus::kFailed);
  const auto wait_error = wait == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
  CancelIoEx(pipe, &operation);
  WaitForSingleObject(operation.hEvent, INFINITE);
  DWORD ignored = 0;
  GetOverlappedResult(pipe, &operation, &ignored, FALSE);
  return {status, 0U, wait_error};
}

bool CurrentUserSecurityDescriptor(LocalAllocation& descriptor,
                                   SECURITY_ATTRIBUTES& attributes) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;

  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  if (bytes == 0U) {
    CloseHandle(token);
    return false;
  }
  std::vector<std::uint8_t> token_buffer(bytes);
  if (!GetTokenInformation(token, TokenUser, token_buffer.data(), bytes, &bytes)) {
    CloseHandle(token);
    return false;
  }
  CloseHandle(token);

  const auto* token_user = reinterpret_cast<const TOKEN_USER*>(token_buffer.data());
  LPWSTR sid_string = nullptr;
  if (!ConvertSidToStringSidW(token_user->User.Sid, &sid_string)) return false;
  LocalAllocation sid_owner(sid_string);

  const std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid_string) + L")";
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &raw_descriptor, nullptr)) {
    return false;
  }
  descriptor.reset(raw_descriptor);
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = descriptor.get();
  attributes.bInheritHandle = FALSE;
  return true;
}

}  // namespace

NamedPipeServer::NamedPipeServer(std::wstring pipe_name, std::uint32_t expected_client_pid)
    : pipe_name_(std::move(pipe_name)),
      expected_client_pid_(expected_client_pid),
      stop_event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

NamedPipeServer::~NamedPipeServer() {
  Stop();
  CloseHandles();
  if (stop_event_ != nullptr) {
    CloseHandle(stop_event_);
    stop_event_ = nullptr;
  }
}

ErrorCode NamedPipeServer::Run(const RequestHandler& handler) {
  if (!handler || pipe_name_.empty() || expected_client_pid_ == 0U || stop_event_ == nullptr) {
    return ErrorCode::kInvalidArgument;
  }
  stop_requested_.store(false, std::memory_order_release);
  ResetEvent(stop_event_);

  LocalAllocation descriptor;
  SECURITY_ATTRIBUTES security{};
  if (!CurrentUserSecurityDescriptor(descriptor, security)) return ErrorCode::kPipeError;

  HANDLE pipe = CreateNamedPipeW(
      pipe_name_.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1U,
      64U * 1024U, 64U * 1024U, 0U, &security);
  if (pipe == INVALID_HANDLE_VALUE) return ErrorCode::kPipeError;

  {
    std::lock_guard lock(handle_mutex_);
    pipe_ = pipe;
  }

  UniqueHandle connect_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!connect_event) {
    CloseHandles();
    return ErrorCode::kPipeError;
  }
  OVERLAPPED connect_operation{};
  connect_operation.hEvent = connect_event.get();
  const BOOL connected_immediately = ConnectNamedPipe(pipe, &connect_operation);
  const auto connect_error = connected_immediately ? ERROR_SUCCESS : GetLastError();
  if (!connected_immediately && connect_error == ERROR_IO_PENDING) {
    const auto completion =
        WaitForPendingIo(pipe, connect_operation, stop_event_, INFINITE);
    if (completion.status != IoStatus::kCompleted) {
      const auto result = completion.status == IoStatus::kStopped ? ErrorCode::kOk
                                                                  : ErrorCode::kPipeError;
      CloseHandles();
      return result;
    }
  } else if (!connected_immediately && connect_error != ERROR_PIPE_CONNECTED) {
    const auto result = stop_requested_.load(std::memory_order_acquire)
                            ? ErrorCode::kOk
                            : ErrorCode::kPipeError;
    CloseHandles();
    return result;
  }

  ULONG client_pid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &client_pid) || client_pid != expected_client_pid_) {
    DisconnectNamedPipe(pipe);
    CloseHandles();
    return ErrorCode::kUnauthorizedClient;
  }
  connected_.store(true, std::memory_order_release);

  FrameDecoder decoder;
  std::array<std::uint8_t, 4096> buffer{};
  ErrorCode result = ErrorCode::kOk;
  bool keep_running = true;
  while (keep_running && !stop_requested_.load(std::memory_order_acquire)) {
    UniqueHandle read_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!read_event) {
      result = ErrorCode::kPipeError;
      break;
    }
    OVERLAPPED read_operation{};
    read_operation.hEvent = read_event.get();
    DWORD bytes_read = 0;
    if (!ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()), nullptr,
                  &read_operation)) {
      const auto read_error = GetLastError();
      if (read_error == ERROR_IO_PENDING) {
        const auto completion = WaitForPendingIo(pipe, read_operation, stop_event_, INFINITE);
        if (completion.status == IoStatus::kCompleted) {
          bytes_read = completion.transferred;
        } else {
          if (completion.status != IoStatus::kStopped && completion.error != ERROR_BROKEN_PIPE &&
              completion.error != ERROR_OPERATION_ABORTED &&
              !stop_requested_.load(std::memory_order_acquire)) {
            result = ErrorCode::kPipeError;
          }
          break;
        }
      } else if (read_error != ERROR_BROKEN_PIPE && read_error != ERROR_OPERATION_ABORTED &&
                 !stop_requested_.load(std::memory_order_acquire)) {
        result = ErrorCode::kPipeError;
        break;
      } else {
        break;
      }
    } else if (!GetOverlappedResult(pipe, &read_operation, &bytes_read, FALSE)) {
      result = ErrorCode::kPipeError;
      break;
    }
    if (bytes_read == 0U) continue;
    auto decoded = decoder.Feed(std::span<const std::uint8_t>(buffer.data(), bytes_read));
    if (decoded.error != ErrorCode::kOk) {
      result = decoded.error;
      break;
    }
    for (const auto& frame : decoded.frames) {
      const auto envelope = DecodeEnvelope(frame);
      if (envelope.error != ErrorCode::kOk) {
        result = envelope.error;
        keep_running = false;
        break;
      }
      if (!handler(envelope.envelope)) {
        keep_running = false;
        break;
      }
    }
  }

  CloseHandles();
  return result;
}

bool NamedPipeServer::Send(const Envelope& envelope) noexcept {
  try {
    const auto encoded = EncodeEnvelope(envelope);
    const auto frame = EncodeFrame(encoded);
    std::lock_guard write_lock(write_mutex_);

    HANDLE pipe = INVALID_HANDLE_VALUE;
    {
      std::lock_guard handle_lock(handle_mutex_);
      pipe = pipe_;
    }
    if (!connected_.load(std::memory_order_acquire) || pipe == INVALID_HANDLE_VALUE) return false;

    const auto fail_connection = [this, pipe]() noexcept {
      // A cancelled byte-stream write may have transferred a frame prefix.
      // Never reuse that connection, or the next frame could desynchronize the
      // peer decoder.
      connected_.store(false, std::memory_order_release);
      stop_requested_.store(true, std::memory_order_release);
      if (stop_event_ != nullptr) SetEvent(stop_event_);
      CancelIoEx(pipe, nullptr);
      return false;
    };

    std::size_t offset = 0;
    while (offset < frame.size()) {
      UniqueHandle write_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      if (!write_event) return fail_connection();
      OVERLAPPED write_operation{};
      write_operation.hEvent = write_event.get();
      DWORD written = 0;
      const auto remaining = static_cast<DWORD>(frame.size() - offset);
      if (!WriteFile(pipe, frame.data() + offset, remaining, nullptr, &write_operation)) {
        if (GetLastError() != ERROR_IO_PENDING) return fail_connection();
        const auto completion = WaitForPendingIo(pipe, write_operation, stop_event_, 2000U);
        if (completion.status != IoStatus::kCompleted) return fail_connection();
        written = completion.transferred;
      } else if (!GetOverlappedResult(pipe, &write_operation, &written, FALSE)) {
        return fail_connection();
      }
      if (written == 0U) return fail_connection();
      offset += written;
    }
    return true;
  } catch (...) {
    return false;
  }
}

void NamedPipeServer::Stop() noexcept {
  stop_requested_.store(true, std::memory_order_release);
  if (stop_event_ != nullptr) SetEvent(stop_event_);
  std::lock_guard lock(handle_mutex_);
  if (pipe_ != INVALID_HANDLE_VALUE) CancelIoEx(pipe_, nullptr);
}

void NamedPipeServer::CloseHandles() noexcept {
  std::lock_guard write_lock(write_mutex_);
  std::lock_guard lock(handle_mutex_);
  const bool was_connected = connected_.exchange(false, std::memory_order_acq_rel);
  if (pipe_ != INVALID_HANDLE_VALUE) {
    if (was_connected) DisconnectNamedPipe(pipe_);
    CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
  }
}

}  // namespace desktop_translate::native
