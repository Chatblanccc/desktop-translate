#include <Windows.h>

#include <cstdint>
#include <iostream>
#include <string>

#include "desktop_translate/native/capture/desktop_duplication_capture.h"
#include "desktop_translate/native/input_hook/mouse_hook.h"
#include "desktop_translate/native/ocr/windows_ocr_adapter.h"
#include "desktop_translate/native/uia/uia_worker.h"

namespace dt = desktop_translate::native;

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

}  // namespace

int main() {
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
