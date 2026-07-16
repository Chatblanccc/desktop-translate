#include <Windows.h>

#include <algorithm>
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
#include "desktop_translate/native/ocr/windows_ocr_adapter.h"
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
    std::uint8_t minimum = 255U;
    std::uint8_t maximum = 0U;
    std::size_t dark_pixels = 0U;
    std::size_t light_pixels = 0U;
    for (std::size_t index = 0; index + 3U < result.bitmap.pixels.size(); index += 4U) {
      const auto blue = result.bitmap.pixels[index];
      const auto green = result.bitmap.pixels[index + 1U];
      const auto red = result.bitmap.pixels[index + 2U];
      const auto luma = static_cast<std::uint8_t>((red * 54U + green * 183U + blue * 19U) >> 8U);
      minimum = std::min(minimum, luma);
      maximum = std::max(maximum, luma);
      if (luma < 64U) ++dark_pixels;
      if (luma > 224U) ++light_pixels;
    }
    std::cout << ",\"width\":" << result.bitmap.width
              << ",\"height\":" << result.bitmap.height
              << ",\"stride\":" << result.bitmap.stride
              << ",\"bytes\":" << result.bitmap.pixels.size()
              << ",\"lumaMin\":" << static_cast<unsigned>(minimum)
              << ",\"lumaMax\":" << static_cast<unsigned>(maximum)
              << ",\"darkPixels\":" << dark_pixels
              << ",\"lightPixels\":" << light_pixels;
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
  auto ocr = dt::CreateWindowsOcrAdapter();
  const auto result = ocr->Recognize(capture.bitmap, 2500U);
  std::cout << "{\"probe\":\"ocr\",\"ok\":" << (result.ok() ? "true" : "false")
            << ",\"error\":" << JsonString(dt::ToString(result.error))
            << ",\"engine\":" << JsonString(ocr->name())
            << ",\"lineCount\":" << result.lines.size();
  if (result.ok()) {
    std::string text;
    for (const auto& line : result.lines) {
      if (!text.empty()) text.push_back('\n');
      text += line.text_utf8;
    }
    std::cout << ",\"text\":" << JsonString(text);
  }
  std::cout
            << ",\"detail\":" << JsonString(result.detail) << "}\n";
  return result.ok() ? 0 : 7;
}

int ProbeSyntheticOcr() {
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
  if (bitmap == nullptr || dc == nullptr || pixels == nullptr) return 9;
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

  dt::CapturedBitmap input;
  input.width = width;
  input.height = height;
  input.stride = width * 4U;
  input.desktop_bounds = {0, 0, width, height};
  input.pixels.assign(static_cast<std::uint8_t*>(pixels),
                      static_cast<std::uint8_t*>(pixels) + input.stride * input.height);
  SelectObject(dc, previous_font);
  SelectObject(dc, previous_bitmap);
  DeleteObject(font);
  DeleteObject(bitmap);
  DeleteDC(dc);

  auto ocr = dt::CreateWindowsOcrAdapter();
  const auto result = ocr->Recognize(input, 2500U);
  std::cout << "{\"probe\":\"ocr-synthetic\",\"ok\":"
            << (result.ok() ? "true" : "false")
            << ",\"error\":" << JsonString(dt::ToString(result.error));
  if (result.ok()) {
    std::string text;
    for (const auto& line : result.lines) {
      if (!text.empty()) text.push_back('\n');
      text += line.text_utf8;
    }
    std::cout << ",\"text\":" << JsonString(text);
  }
  std::cout << ",\"lineCount\":" << result.lines.size()
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

std::optional<dt::PhysicalRect> ForegroundRect() {
  const auto window = GetForegroundWindow();
  RECT rect{};
  if (window == nullptr || !GetWindowRect(window, &rect) || rect.right <= rect.left ||
      rect.bottom <= rect.top) {
    return std::nullopt;
  }
  return dt::PhysicalRect{rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top};
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
  if (argc == 2 && std::wstring_view(argv[1]) == L"--ocr-synthetic") {
    return ProbeSyntheticOcr();
  }
  if (argc == 2 && std::wstring_view(argv[1]) == L"--uia-foreground") {
    const auto rect = ForegroundRect();
    if (!rect) return 2;
    return ProbeUia({rect->x + rect->width / 2, rect->y + rect->height / 2});
  }
  if (argc == 2 && std::wstring_view(argv[1]) == L"--ocr-foreground") {
    const auto rect = ForegroundRect();
    if (!rect) return 2;
    return ProbeOcr(*rect);
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
                L"  selection-host-probe --ocr-synthetic\n"
                L"  selection-host-probe --uia-foreground\n"
                L"  selection-host-probe --ocr-foreground\n"
                L"  selection-host-probe --all\n";
  return 2;
}
