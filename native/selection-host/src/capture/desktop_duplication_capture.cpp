#include "desktop_translate/native/capture/desktop_duplication_capture.h"

#include <Windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstring>
#include <iterator>
#include <limits>
#include <utility>

#include "desktop_translate/native/coordinates/coordinates.h"

namespace desktop_translate::native {
namespace {

using Microsoft::WRL::ComPtr;

struct OutputMatch {
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput1> output;
  DXGI_OUTPUT_DESC description{};
};

struct AcquiredFrameGuard {
  IDXGIOutputDuplication* duplication{};
  ~AcquiredFrameGuard() {
    if (duplication != nullptr) duplication->ReleaseFrame();
  }
};

CaptureResult Failure(ErrorCode error, std::string detail) {
  return {error, {}, std::move(detail)};
}

bool FindOutputForMonitor(HMONITOR monitor, OutputMatch& match) {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;

  for (UINT adapter_index = 0;; ++adapter_index) {
    ComPtr<IDXGIAdapter1> adapter;
    const auto adapter_hr = factory->EnumAdapters1(adapter_index, &adapter);
    if (adapter_hr == DXGI_ERROR_NOT_FOUND) break;
    if (FAILED(adapter_hr)) continue;

    for (UINT output_index = 0;; ++output_index) {
      ComPtr<IDXGIOutput> output;
      const auto output_hr = adapter->EnumOutputs(output_index, &output);
      if (output_hr == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(output_hr)) continue;

      DXGI_OUTPUT_DESC description{};
      if (FAILED(output->GetDesc(&description)) || description.Monitor != monitor) continue;

      ComPtr<IDXGIOutput1> output1;
      if (FAILED(output.As(&output1))) return false;
      match = {adapter, output1, description};
      return true;
    }
  }
  return false;
}

CaptureResult CaptureWithGdi(PhysicalRect roi, std::string reason) {
  const auto screen = GetDC(nullptr);
  if (screen == nullptr) return Failure(ErrorCode::kCaptureUnavailable, "desktop DC unavailable");
  const auto memory = CreateCompatibleDC(screen);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = roi.width;
  info.bmiHeader.biHeight = -roi.height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  const auto dib = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &pixels, nullptr, 0U);
  if (memory == nullptr || dib == nullptr || pixels == nullptr) {
    if (dib != nullptr) DeleteObject(dib);
    if (memory != nullptr) DeleteDC(memory);
    ReleaseDC(nullptr, screen);
    return Failure(ErrorCode::kCaptureUnavailable, "GDI capture allocation failed");
  }
  const auto previous = SelectObject(memory, dib);
  const bool copied = BitBlt(memory, 0, 0, roi.width, roi.height, screen, roi.x, roi.y,
                             SRCCOPY | CAPTUREBLT) == TRUE;
  GdiFlush();

  CapturedBitmap bitmap;
  if (copied) {
    bitmap.desktop_bounds = roi;
    bitmap.width = static_cast<std::uint32_t>(roi.width);
    bitmap.height = static_cast<std::uint32_t>(roi.height);
    bitmap.stride = bitmap.width * 4U;
    const auto size = static_cast<std::size_t>(bitmap.stride) * bitmap.height;
    bitmap.pixels.assign(static_cast<std::uint8_t*>(pixels),
                         static_cast<std::uint8_t*>(pixels) + size);
  }
  SelectObject(memory, previous);
  DeleteObject(dib);
  DeleteDC(memory);
  ReleaseDC(nullptr, screen);
  if (!copied) return Failure(ErrorCode::kCaptureUnavailable, "GDI BitBlt failed");
  return {ErrorCode::kOk, std::move(bitmap), std::move(reason)};
}

bool IsCompletelyBlack(const CapturedBitmap& bitmap) {
  for (std::size_t index = 0; index + 3U < bitmap.pixels.size(); index += 4U) {
    if (bitmap.pixels[index] != 0U || bitmap.pixels[index + 1U] != 0U ||
        bitmap.pixels[index + 2U] != 0U) {
      return false;
    }
  }
  return true;
}

CaptureResult CaptureWithGdiChecked(PhysicalRect roi, std::string reason) {
  auto result = CaptureWithGdi(roi, std::move(reason));
  if (result.ok() && IsCompletelyBlack(result.bitmap)) {
    return Failure(ErrorCode::kCaptureProtected,
                   "capture returned no visible pixels (protected or blank surface)");
  }
  return result;
}

PhysicalRect OutputBounds(const DXGI_OUTPUT_DESC& description) {
  const auto& rect = description.DesktopCoordinates;
  return {rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top};
}

}  // namespace

CaptureResult DesktopDuplicationCapture::CaptureRoi(PhysicalRect roi,
                                                     std::uint32_t timeout_ms) {
  roi = ClampToVirtualDesktop(roi);
  if (roi.IsEmpty()) return Failure(ErrorCode::kInvalidArgument, "capture ROI is empty");

  RECT win32_roi{roi.x, roi.y, roi.Right(), roi.Bottom()};
  const auto monitor = MonitorFromRect(&win32_roi, MONITOR_DEFAULTTONULL);
  if (monitor == nullptr) {
    return Failure(ErrorCode::kCaptureUnavailable, "no monitor intersects capture ROI");
  }

  OutputMatch match;
  if (!FindOutputForMonitor(monitor, match)) {
    return Failure(ErrorCode::kCaptureUnavailable, "DXGI output was not found for monitor");
  }
  if (match.description.Rotation != DXGI_MODE_ROTATION_IDENTITY &&
      match.description.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
    const auto rotated_roi = IntersectRects(roi, OutputBounds(match.description));
    if (rotated_roi.IsEmpty()) {
      return Failure(ErrorCode::kInvalidArgument, "capture ROI does not intersect rotated output");
    }
    return CaptureWithGdiChecked(rotated_roi, "GDI fallback used for rotated output");
  }

  const auto clipped = IntersectRects(roi, OutputBounds(match.description));
  if (clipped.IsEmpty()) {
    return Failure(ErrorCode::kInvalidArgument, "capture ROI does not intersect selected output");
  }

  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  constexpr D3D_FEATURE_LEVEL kFeatureLevels[] = {D3D_FEATURE_LEVEL_11_0};
  const auto device_hr = D3D11CreateDevice(
      match.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      kFeatureLevels, static_cast<UINT>(std::size(kFeatureLevels)), D3D11_SDK_VERSION, &device,
      nullptr, &context);
  if (FAILED(device_hr)) {
    return Failure(ErrorCode::kCaptureUnavailable, "D3D11CreateDevice failed");
  }

  ComPtr<IDXGIOutputDuplication> duplication;
  const auto duplicate_hr = match.output->DuplicateOutput(device.Get(), &duplication);
  if (FAILED(duplicate_hr)) {
    return Failure(duplicate_hr == E_ACCESSDENIED ? ErrorCode::kCaptureProtected
                                                  : ErrorCode::kCaptureUnavailable,
                   duplicate_hr == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
                       ? "desktop duplication session limit reached"
                       : "DuplicateOutput failed (secure desktop or unsupported adapter)");
  }

  DXGI_OUTDUPL_FRAME_INFO frame_info{};
  ComPtr<IDXGIResource> desktop_resource;
  const auto acquire_hr = duplication->AcquireNextFrame(timeout_ms, &frame_info, &desktop_resource);
  if (acquire_hr == DXGI_ERROR_WAIT_TIMEOUT) {
    return Failure(ErrorCode::kCaptureTimeout, "AcquireNextFrame timed out");
  }
  if (FAILED(acquire_hr)) {
    return Failure(acquire_hr == DXGI_ERROR_ACCESS_LOST ? ErrorCode::kCaptureAccessLost
                                                        : ErrorCode::kCaptureUnavailable,
                   acquire_hr == DXGI_ERROR_ACCESS_LOST ? "desktop duplication access was lost"
                                                        : "AcquireNextFrame failed");
  }
  AcquiredFrameGuard frame_guard{duplication.Get()};

  ComPtr<ID3D11Texture2D> source;
  if (FAILED(desktop_resource.As(&source))) {
    return Failure(ErrorCode::kCaptureUnavailable, "desktop frame is not a D3D11 texture");
  }
  D3D11_TEXTURE2D_DESC source_description{};
  source->GetDesc(&source_description);
  if (source_description.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
    return Failure(ErrorCode::kCaptureUnavailable, "desktop frame is not BGRA8");
  }

  const auto output_bounds = OutputBounds(match.description);
  const auto local_left = static_cast<UINT>(clipped.x - output_bounds.x);
  const auto local_top = static_cast<UINT>(clipped.y - output_bounds.y);
  const auto width = static_cast<UINT>(clipped.width);
  const auto height = static_cast<UINT>(clipped.height);
  if (local_left + width > source_description.Width ||
      local_top + height > source_description.Height) {
    return Failure(ErrorCode::kCaptureUnavailable, "ROI exceeds duplication surface bounds");
  }

  D3D11_TEXTURE2D_DESC staging_description{};
  staging_description.Width = width;
  staging_description.Height = height;
  staging_description.MipLevels = 1;
  staging_description.ArraySize = 1;
  staging_description.Format = source_description.Format;
  staging_description.SampleDesc.Count = 1;
  staging_description.Usage = D3D11_USAGE_STAGING;
  staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

  ComPtr<ID3D11Texture2D> staging;
  if (FAILED(device->CreateTexture2D(&staging_description, nullptr, &staging))) {
    return Failure(ErrorCode::kCaptureUnavailable, "staging texture creation failed");
  }

  D3D11_BOX source_box{local_left, local_top, 0U, local_left + width,
                       local_top + height, 1U};
  context->CopySubresourceRegion(staging.Get(), 0U, 0U, 0U, 0U, source.Get(), 0U, &source_box);

  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(context->Map(staging.Get(), 0U, D3D11_MAP_READ, 0U, &mapped))) {
    return Failure(ErrorCode::kCaptureUnavailable, "staging texture map failed");
  }

  const std::uint64_t stride64 = static_cast<std::uint64_t>(width) * 4U;
  const std::uint64_t size64 = stride64 * height;
  if (size64 > std::numeric_limits<std::size_t>::max()) {
    context->Unmap(staging.Get(), 0U);
    return Failure(ErrorCode::kInvalidArgument, "capture ROI is too large");
  }

  CapturedBitmap bitmap;
  bitmap.desktop_bounds = clipped;
  bitmap.width = width;
  bitmap.height = height;
  bitmap.stride = static_cast<std::uint32_t>(stride64);
  bitmap.pixels.resize(static_cast<std::size_t>(size64));
  for (UINT row = 0; row < height; ++row) {
    const auto* source_row = static_cast<const std::uint8_t*>(mapped.pData) +
                             static_cast<std::size_t>(row) * mapped.RowPitch;
    auto* destination_row = bitmap.pixels.data() +
                            static_cast<std::size_t>(row) * bitmap.stride;
    std::memcpy(destination_row, source_row, bitmap.stride);
  }
  context->Unmap(staging.Get(), 0U);
  if (IsCompletelyBlack(bitmap)) {
    return CaptureWithGdiChecked(clipped, "GDI fallback used after a black DXGI frame");
  }
  return {ErrorCode::kOk, std::move(bitmap), {}};
}

}  // namespace desktop_translate::native
