#include <Windows.h>

#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <cwchar>
#include <future>
#include <iostream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>

#include "desktop_translate/native/capture/desktop_duplication_capture.h"
#include "desktop_translate/native/core/envelope.h"
#include "desktop_translate/native/ocr/paddle_ocr_adapter.h"
#include "desktop_translate/native/uia/uia_worker.h"

namespace dt = desktop_translate::native;

namespace {

std::optional<std::int32_t> ParseInt(const wchar_t* value) {
  if (value == nullptr || *value == L'\0') return std::nullopt;
  wchar_t* end = nullptr;
  errno = 0;
  const auto parsed = std::wcstoll(value, &end, 10);
  if (errno != 0 || end == value || *end != L'\0' ||
      parsed < std::numeric_limits<std::int32_t>::min() ||
      parsed > std::numeric_limits<std::int32_t>::max()) {
    return std::nullopt;
  }
  return static_cast<std::int32_t>(parsed);
}

std::string JsonString(std::string_view value) {
  return "\"" + dt::EscapeJsonString(value) + "\"";
}

int ProbeUia(dt::PhysicalPoint point) {
  dt::UiaWorker worker;
  if (!worker.Start()) {
    std::cout << "{\"probe\":\"uia\",\"ok\":false,\"error\":\"uia_unavailable\"}\n";
    return 3;
  }
  auto future = worker.TryGetSelection(point, 2000U);
  if (!future || future->wait_for(std::chrono::seconds(2)) != std::future_status::ready) {
    std::cout << "{\"probe\":\"uia\",\"ok\":false,\"error\":\"uia_timeout\"}\n";
    return 4;
  }
  const auto result = future->get();
  std::cout << "{\"probe\":\"uia\",\"ok\":" << (result.ok() ? "true" : "false")
            << ",\"error\":" << JsonString(dt::ToString(result.error));
  if (result.ok()) {
    std::cout << ",\"text\":" << JsonString(result.selection.text_utf8)
              << ",\"rectCount\":" << result.selection.bounds.size();
  } else {
    std::cout << ",\"detail\":" << JsonString(result.detail);
  }
  std::cout << "}\n";
  return result.ok() ? 0 : 5;
}

dt::CaptureResult Capture(dt::PhysicalRect roi) {
  dt::DesktopDuplicationCapture capture;
  return capture.CaptureRoi(roi, 1000U);
}

int ProbeDxgi(dt::PhysicalRect roi) {
  const auto result = Capture(roi);
  std::cout << "{\"probe\":\"dxgi\",\"ok\":" << (result.ok() ? "true" : "false")
            << ",\"error\":" << JsonString(dt::ToString(result.error));
  if (result.ok()) {
    std::cout << ",\"width\":" << result.bitmap.width
              << ",\"height\":" << result.bitmap.height
              << ",\"stride\":" << result.bitmap.stride
              << ",\"bytes\":" << result.bitmap.pixels.size();
  } else {
    std::cout << ",\"detail\":" << JsonString(result.detail);
  }
  std::cout << "}\n";
  return result.ok() ? 0 : 6;
}

int ProbeOcr(dt::PhysicalRect roi) {
  auto capture = Capture(roi);
  if (!capture.ok()) {
    std::cout << "{\"probe\":\"ocr\",\"ok\":false,\"error\":"
              << JsonString(dt::ToString(capture.error)) << ",\"stage\":\"capture\"}\n";
    return 6;
  }
  auto ocr = dt::CreatePaddleOcrAdapter();
  const auto result = ocr->Recognize(capture.bitmap, 2500U);
  std::cout << "{\"probe\":\"ocr\",\"ok\":" << (result.ok() ? "true" : "false")
            << ",\"error\":" << JsonString(dt::ToString(result.error))
            << ",\"engine\":" << JsonString(ocr->name())
            << ",\"lineCount\":" << result.lines.size()
            << ",\"detail\":" << JsonString(result.detail) << "}\n";
  return result.ok() ? 0 : 7;
}

std::optional<dt::PhysicalRect> ParseRect(int argc, wchar_t** argv, int start) {
  if (argc < start + 4) return std::nullopt;
  const auto x = ParseInt(argv[start]);
  const auto y = ParseInt(argv[start + 1]);
  const auto width = ParseInt(argv[start + 2]);
  const auto height = ParseInt(argv[start + 3]);
  if (!x || !y || !width || !height || *width <= 0 || *height <= 0) return std::nullopt;
  return dt::PhysicalRect{*x, *y, *width, *height};
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  (void)SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (argc == 4 && std::wstring_view(argv[1]) == L"--uia") {
    const auto x = ParseInt(argv[2]);
    const auto y = ParseInt(argv[3]);
    if (x && y) return ProbeUia({*x, *y});
  }
  if (argc == 6 && std::wstring_view(argv[1]) == L"--dxgi") {
    if (const auto rect = ParseRect(argc, argv, 2)) return ProbeDxgi(*rect);
  }
  if (argc == 6 && std::wstring_view(argv[1]) == L"--ocr") {
    if (const auto rect = ParseRect(argc, argv, 2)) return ProbeOcr(*rect);
  }
  if (argc == 2 && std::wstring_view(argv[1]) == L"--all") {
    POINT cursor{};
    if (!GetCursorPos(&cursor)) return 2;
    const auto uia = ProbeUia({cursor.x, cursor.y});
    const dt::PhysicalRect roi{cursor.x - 160, cursor.y - 60, 320, 120};
    const auto dxgi = ProbeDxgi(roi);
    const auto ocr = ProbeOcr(roi);
    return uia == 0 && dxgi == 0 && ocr == 0 ? 0 : 8;
  }

  std::wcerr << L"usage:\n"
                L"  selection-host-probe --uia <x> <y>\n"
                L"  selection-host-probe --dxgi <x> <y> <width> <height>\n"
                L"  selection-host-probe --ocr <x> <y> <width> <height>\n"
                L"  selection-host-probe --all\n";
  return 2;
}
