#include "desktop_translate/native/ocr/windows_ocr_adapter.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>
#include <utility>

#if DT_NATIVE_ENABLE_WINDOWS_OCR
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/base.h>
#endif

namespace desktop_translate::native {
namespace {

#if DT_NATIVE_ENABLE_WINDOWS_OCR
using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Graphics::Imaging;
using namespace Windows::Media::Ocr;
using namespace Windows::Storage::Streams;

class ApartmentScope {
 public:
  ApartmentScope() { init_apartment(apartment_type::multi_threaded); }
  ~ApartmentScope() { uninit_apartment(); }
  ApartmentScope(const ApartmentScope&) = delete;
  ApartmentScope& operator=(const ApartmentScope&) = delete;
};

PhysicalRect ToBounds(const Windows::Media::Ocr::OcrLine& line) {
  bool has_bounds = false;
  double left = 0;
  double top = 0;
  double right = 0;
  double bottom = 0;
  for (const auto& word : line.Words()) {
    const auto rect = word.BoundingRect();
    if (rect.Width <= 0 || rect.Height <= 0) continue;
    if (!has_bounds) {
      left = rect.X;
      top = rect.Y;
      right = rect.X + rect.Width;
      bottom = rect.Y + rect.Height;
      has_bounds = true;
    } else {
      left = std::min(left, static_cast<double>(rect.X));
      top = std::min(top, static_cast<double>(rect.Y));
      right = std::max(right, static_cast<double>(rect.X + rect.Width));
      bottom = std::max(bottom, static_cast<double>(rect.Y + rect.Height));
    }
  }
  if (!has_bounds) return {};
  return {
      static_cast<std::int32_t>(std::floor(left)),
      static_cast<std::int32_t>(std::floor(top)),
      static_cast<std::int32_t>(std::ceil(right - left)),
      static_cast<std::int32_t>(std::ceil(bottom - top)),
  };
}
#endif

}  // namespace

bool WindowsOcrAdapter::available() const noexcept {
#if DT_NATIVE_ENABLE_WINDOWS_OCR
  static const bool cached = [] {
    CapturedBitmap bitmap;
    bitmap.desktop_bounds = {0, 0, 32, 32};
    bitmap.width = 32U;
    bitmap.height = 32U;
    bitmap.stride = 128U;
    bitmap.pixels.assign(static_cast<std::size_t>(bitmap.stride) * bitmap.height, 255U);
    WindowsOcrAdapter probe;
    const auto result = probe.Recognize(bitmap, 1000U);
    return result.error != ErrorCode::kOcrUnavailable && result.error != ErrorCode::kInternalError;
  }();
  return cached;
#else
  return false;
#endif
}

std::string WindowsOcrAdapter::name() const { return "windows-media-ocr"; }

OcrResult WindowsOcrAdapter::Recognize(const CapturedBitmap& bitmap,
                                       std::uint32_t timeout_ms) {
#if DT_NATIVE_ENABLE_WINDOWS_OCR
  if (bitmap.width == 0U || bitmap.height == 0U || bitmap.pixels.empty() ||
      bitmap.stride < bitmap.width * 4U) {
    return {ErrorCode::kInvalidArgument, {}, "OCR bitmap is empty or malformed"};
  }
  if (timeout_ms == 0U) {
    return {ErrorCode::kInvalidArgument, {}, "OCR timeout must be positive"};
  }
  try {
    ApartmentScope apartment;
    const auto engine = OcrEngine::TryCreateFromUserProfileLanguages();
    if (engine == nullptr) {
      return {ErrorCode::kOcrUnavailable, {}, "Windows has no installed OCR language"};
    }

    SoftwareBitmap software_bitmap(
        BitmapPixelFormat::Bgra8,
        static_cast<std::int32_t>(bitmap.width),
        static_cast<std::int32_t>(bitmap.height),
        BitmapAlphaMode::Ignore);
    const auto byte_count = static_cast<std::uint32_t>(bitmap.width * bitmap.height * 4U);
    Buffer buffer(byte_count);
    buffer.Length(byte_count);
    auto* destination = buffer.data();
    const auto row_bytes = static_cast<std::size_t>(bitmap.width) * 4U;
    for (std::uint32_t row = 0; row < bitmap.height; ++row) {
      std::memcpy(destination + static_cast<std::size_t>(row) * row_bytes,
                  bitmap.pixels.data() + static_cast<std::size_t>(row) * bitmap.stride,
                  row_bytes);
    }
    software_bitmap.CopyFromBuffer(buffer);

    const auto operation = engine.RecognizeAsync(software_bitmap);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    while (operation.Status() == AsyncStatus::Started &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    if (operation.Status() == AsyncStatus::Started) {
      operation.Cancel();
      return {ErrorCode::kOcrTimeout, {}, "Windows OCR timed out"};
    }
    if (operation.Status() != AsyncStatus::Completed) {
      return {ErrorCode::kOcrUnavailable, {}, "Windows OCR did not complete"};
    }

    OcrResult output{ErrorCode::kOk, {}, {}};
    for (const auto& line : operation.GetResults().Lines()) {
      const auto text = to_string(line.Text());
      const auto bounds = ToBounds(line);
      if (text.empty() || bounds.IsEmpty()) continue;
      // Windows.Media.Ocr does not expose probability. A conservative neutral
      // confidence keeps policy explicit without claiming model calibration.
      output.lines.push_back({text, bounds, 0.75F});
    }
    if (output.lines.empty()) {
      return {ErrorCode::kOcrNoText, {}, "Windows OCR returned no usable text"};
    }
    return output;
  } catch (const winrt::hresult_error&) {
    return {ErrorCode::kOcrUnavailable, {}, "Windows OCR raised a WinRT error"};
  } catch (...) {
    return {ErrorCode::kInternalError, {}, "Windows OCR raised an exception"};
  }
#else
  (void)bitmap;
  (void)timeout_ms;
  return {ErrorCode::kOcrUnavailable, {}, "Windows OCR support is not linked"};
#endif
}

std::unique_ptr<IOcrEngine> CreateWindowsOcrAdapter() {
  return std::make_unique<WindowsOcrAdapter>();
}

}  // namespace desktop_translate::native
