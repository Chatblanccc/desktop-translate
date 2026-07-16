#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

#include "desktop_translate/native/app/parent_process_monitor.h"
#include "desktop_translate/native/capture/desktop_duplication_capture.h"
#include "desktop_translate/native/core/host_state_machine.h"
#include "desktop_translate/native/input_hook/mouse_hook.h"
#include "desktop_translate/native/ipc/named_pipe_server.h"
#include "desktop_translate/native/ocr/ocr_engine.h"
#include "desktop_translate/native/selection/selection_pipeline.h"
#include "desktop_translate/native/uia/uia_worker.h"

namespace desktop_translate::native {

struct SelectionHostOptions {
  std::wstring pipe_name;
  std::uint32_t parent_pid{};
  std::string session_nonce;
};

class SelectionHostApp {
 public:
  explicit SelectionHostApp(SelectionHostOptions options);
  ~SelectionHostApp();
  SelectionHostApp(const SelectionHostApp&) = delete;
  SelectionHostApp& operator=(const SelectionHostApp&) = delete;

  [[nodiscard]] int Run();

 private:
  [[nodiscard]] bool HandleRequest(const Envelope& envelope);
  void HandlePipelineResult(SelectionPipelineResult result) noexcept;
  [[nodiscard]] bool StartListening(const Envelope& request);
  void StopListening() noexcept;
  [[nodiscard]] bool SendResponse(const Envelope& request, std::string method,
                                  std::string payload_json) noexcept;
  void SendError(ErrorCode error, std::string scope, std::string message,
                 std::optional<std::string> related_request_id = {},
                 std::optional<std::string> selection_id = {}) noexcept;
  [[nodiscard]] std::string CapabilitiesJson() const;
  [[nodiscard]] std::string DegradedCapabilitiesJson() const;

  SelectionHostOptions options_;
  HostStateMachine state_;
  NamedPipeServer pipe_server_;
  ParentProcessMonitor parent_monitor_;
  MouseHook mouse_hook_;
  UiaWorker uia_worker_;
  DesktopDuplicationCapture capture_;
  std::unique_ptr<IOcrEngine> ocr_engine_;
  std::unique_ptr<SelectionPipeline> pipeline_;
  SelectionPipelineConfig effective_config_;
  std::atomic<bool> handshake_complete_{false};
  std::atomic<std::uint64_t> next_event_sequence_{0};
  std::atomic<std::uint64_t> last_event_sequence_{0};
  std::uint64_t started_tick_ms_{};
};

}  // namespace desktop_translate::native
