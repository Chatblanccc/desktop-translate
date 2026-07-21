#include <Windows.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "desktop_translate/native/capture/desktop_duplication_capture.h"
#include "desktop_translate/native/input_hook/mouse_hook.h"
#include "desktop_translate/native/ipc/sequenced_event_writer.h"
#include "desktop_translate/native/ocr/windows_ocr_adapter.h"
#include "desktop_translate/native/selection/selection_pipeline.h"
#include "desktop_translate/native/uia/uia_worker.h"

namespace dt = desktop_translate::native;

namespace desktop_translate::native {

class MouseHookTestPeer {
 public:
  static void Emit(MouseHook& hook, WPARAM message, const MSLLHOOKSTRUCT& data) noexcept {
    hook.OnHookEvent(message, data);
  }
};

}  // namespace desktop_translate::native

namespace {

int failures = 0;

void Check(bool condition, const char* message) {
  if (condition) return;
  ++failures;
  std::cerr << "FAIL: " << message << '\n';
}

dt::CapturedBitmap SyntheticTextBitmap() {
  constexpr int width = 900;
  constexpr int height = 180;
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  const auto bitmap = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &pixels, nullptr, 0U);
  const auto dc = CreateCompatibleDC(nullptr);
  Check(bitmap != nullptr && dc != nullptr && pixels != nullptr, "synthetic bitmap allocation");
  if (bitmap == nullptr || dc == nullptr || pixels == nullptr) return {};
  const auto previous_bitmap = SelectObject(dc, bitmap);
  RECT area{0, 0, width, height};
  FillRect(dc, &area, static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(0, 0, 0));
  const auto font = CreateFontW(54, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
  const auto previous_font = SelectObject(dc, font);
  DrawTextW(dc, L"Phase Three OCR Validation 12345", -1, &area,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  GdiFlush();

  dt::CapturedBitmap result;
  result.width = width;
  result.height = height;
  result.stride = width * 4U;
  result.desktop_bounds = {0, 0, width, height};
  result.pixels.assign(static_cast<std::uint8_t*>(pixels),
                       static_cast<std::uint8_t*>(pixels) + result.stride * result.height);
  SelectObject(dc, previous_font);
  SelectObject(dc, previous_bitmap);
  DeleteObject(font);
  DeleteObject(bitmap);
  DeleteDC(dc);
  return result;
}

class UnavailableCapture final : public dt::IScreenCapture {
 public:
  dt::CaptureResult CaptureRoi(dt::PhysicalRect, std::uint32_t) override {
    return {dt::ErrorCode::kCaptureUnavailable, {}, "not used by pointer-down test"};
  }
};

class UnavailableOcr final : public dt::IOcrEngine {
 public:
  bool available() const noexcept override { return false; }
  std::string name() const override { return "unavailable-test-ocr"; }
  dt::OcrResult Recognize(const dt::CapturedBitmap&, std::uint32_t) override {
    return {dt::ErrorCode::kOcrUnavailable, {}, "not used by pointer-down test"};
  }
};

void TestSelectionPipelinePublishesOnlyPhysicalPointerDown() {
  dt::MouseHook hook;
  dt::UiaWorker uia;
  UnavailableCapture capture;
  UnavailableOcr ocr;
  std::mutex mutex;
  std::condition_variable condition;
  std::uint32_t pointer_down_count = 0;
  dt::PhysicalPoint observed_point{};

  dt::SelectionPipeline pipeline(
      hook, uia, capture, ocr, [](dt::SelectionPipelineResult) {},
      [&](dt::PhysicalPoint point) {
        {
          std::lock_guard lock(mutex);
          ++pointer_down_count;
          observed_point = point;
        }
        condition.notify_one();
      });
  Check(pipeline.Start(), "selection pipeline starts for pointer-down activity test");

  MSLLHOOKSTRUCT injected{};
  injected.pt = {-20, 30};
  injected.flags = LLMHF_INJECTED;
  dt::MouseHookTestPeer::Emit(hook, WM_LBUTTONDOWN, injected);
  {
    std::unique_lock lock(mutex);
    const bool notified = condition.wait_for(
        lock, std::chrono::milliseconds(150), [&] { return pointer_down_count != 0U; });
    Check(!notified, "injected pointer-down input remains rejected before the pipeline");
  }

  MSLLHOOKSTRUCT physical{};
  physical.pt = {-12, 44};
  dt::MouseHookTestPeer::Emit(hook, WM_LBUTTONDOWN, physical);
  {
    std::unique_lock lock(mutex);
    const bool notified = condition.wait_for(
        lock, std::chrono::seconds(1), [&] { return pointer_down_count == 1U; });
    Check(notified, "pipeline consumer publishes a physical pointer-down activity");
    Check(observed_point.x == -12 && observed_point.y == 44,
          "pointer-down activity preserves signed physical coordinates");
  }
  pipeline.Stop();
}

void TestSequencedEventWriterSerializesConcurrentProducers() {
  std::vector<std::uint64_t> observed_sequences;
  dt::SequencedEventWriter writer([&](const dt::Envelope& event) {
    observed_sequences.push_back(event.sequence.value());
    // Widen the race window: allocation and delivery must remain one operation.
    Sleep(static_cast<DWORD>(event.sequence.value() % 3U));
    return true;
  });

  constexpr std::size_t kProducerCount = 8U;
  constexpr std::size_t kEventsPerProducer = 64U;
  std::atomic<std::size_t> send_failures{0U};
  std::vector<std::thread> producers;
  producers.reserve(kProducerCount);
  for (std::size_t producer = 0; producer < kProducerCount; ++producer) {
    producers.emplace_back([&] {
      for (std::size_t index = 0; index < kEventsPerProducer; ++index) {
        if (!writer.Send("test/event", "2026-07-21T00:00:00.000Z", "{}")) {
          send_failures.fetch_add(1U, std::memory_order_relaxed);
        }
      }
    });
  }
  for (auto& producer : producers) producer.join();

  Check(send_failures.load(std::memory_order_relaxed) == 0U,
        "all concurrent events are delivered");
  Check(observed_sequences.size() == kProducerCount * kEventsPerProducer,
        "all concurrent events reach the send sink");
  for (std::size_t index = 0; index < observed_sequences.size(); ++index) {
    Check(observed_sequences[index] == index,
          "concurrent event sequences remain strictly increasing on the wire");
  }
  if (!observed_sequences.empty()) {
    Check(writer.last_sequence() == observed_sequences.back(),
          "health sequence reflects the last delivered event");
  }
}

}  // namespace

int main() {
  std::cerr << "[windows-tests] Concurrent event sequencing\n";
  TestSequencedEventWriterSerializesConcurrentProducers();

  std::cerr << "[windows-tests] Pointer-down activity\n";
  TestSelectionPipelinePublishesOnlyPhysicalPointerDown();

  std::cerr << "[windows-tests] Password masking policy\n";
  Check(dt::IsMaskedPasswordRepresentation(L"••••••••"),
        "bullet-only selection is treated as a password representation");
  Check(dt::IsMaskedPasswordRepresentation(L"********"),
        "asterisk-only selection is treated as a password representation");
  Check(!dt::IsMaskedPasswordRepresentation(L"Phase • Three"),
        "ordinary text containing a bullet is not rejected");
  Check(!dt::IsMaskedPasswordRepresentation(L" \t\r\n"),
        "whitespace-only selection is not classified as a password mask");

  std::cerr << "[windows-tests] OCR availability\n";
  auto ocr = dt::CreateWindowsOcrAdapter();
  Check(ocr->available(), "Windows OCR must be available on the Phase 3 Windows gate");
  const auto result = ocr->Recognize(SyntheticTextBitmap(), 2500U);
  std::cerr << "[windows-tests] OCR completed\n";
  Check(result.ok(), "synthetic Windows OCR succeeds");
  Check(result.lines.size() == 1U, "synthetic Windows OCR returns one line");
  if (!result.lines.empty()) {
    Check(result.lines.front().text_utf8 == "Phase Three OCR Validation 12345",
          "synthetic Windows OCR text is exact");
    Check(!result.lines.front().bounds.IsEmpty(), "synthetic Windows OCR returns bounds");
    Check(result.lines.front().confidence >= 0.5F, "synthetic OCR meets confidence policy");
  }

  std::cerr << "[windows-tests] Hook start\n";
  dt::MouseHook hook;
  Check(hook.Start(), "WH_MOUSE_LL installs on the Windows gate");
  Check(hook.installed(), "mouse hook reports installed state");
  hook.Stop();
  std::cerr << "[windows-tests] Hook stopped\n";
  Check(!hook.installed(), "mouse hook clears installed state after stop");

  if (failures == 0) std::cout << "Phase 3 Windows Native tests passed\n";
  return failures == 0 ? 0 : 1;
}
