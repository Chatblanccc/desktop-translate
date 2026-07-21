#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "desktop_translate/native/capture/screen_capture.h"
#include "desktop_translate/native/input_hook/mouse_hook.h"
#include "desktop_translate/native/ocr/ocr_engine.h"
#include "desktop_translate/native/uia/uia_worker.h"

namespace desktop_translate::native {

struct SelectionPipelineResult {
  std::string selection_id;
  std::string source;
  SelectionResult selection;
  ErrorCode capture_error{ErrorCode::kOk};
  ErrorCode ocr_error{ErrorCode::kOk};
  PhysicalRect attempted_roi;
  PhysicalPoint release_point;
  std::uint32_t target_pid{};
  std::uintptr_t target_hwnd{};
  float confidence{};
};

struct SelectionPipelineConfig {
  bool enable_uia{true};
  bool enable_ocr_fallback{true};
  bool ocr_requires_alt_drag{false};
  std::uint32_t settle_delay_ms{80};
  double minimum_drag_distance_px{4.0};
  std::uint32_t uia_timeout_ms{350};
  std::uint32_t ocr_timeout_ms{2500};
  std::vector<std::string> excluded_process_names;
};

class SelectionPipeline {
 public:
  using ResultSink = std::function<void(SelectionPipelineResult)>;
  using PointerDownSink = std::function<void(PhysicalPoint)>;

  SelectionPipeline(MouseHook& mouse_hook, UiaWorker& uia_worker,
                    IScreenCapture& screen_capture, IOcrEngine& ocr_engine,
                    ResultSink result_sink, PointerDownSink pointer_down_sink);
  ~SelectionPipeline();

  [[nodiscard]] bool Start();
  void Stop() noexcept;
  [[nodiscard]] bool SetConfig(SelectionPipelineConfig config) noexcept;
  [[nodiscard]] bool running() const noexcept {
    return running_.load(std::memory_order_acquire);
  }

 private:
  void ThreadMain() noexcept;
  void ResolveSelection(std::uint64_t generation, PhysicalPoint anchor,
                        PhysicalRect roi, bool allow_ocr) noexcept;

  MouseHook& mouse_hook_;
  UiaWorker& uia_worker_;
  IScreenCapture& screen_capture_;
  IOcrEngine& ocr_engine_;
  ResultSink result_sink_;
  PointerDownSink pointer_down_sink_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  SelectionPipelineConfig config_;
};

}  // namespace desktop_translate::native
