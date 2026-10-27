#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;

static void check(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        char text[160]; sprintf_s(text, "%s failed: 0x%08lx", operation, static_cast<unsigned long>(result));
        throw std::runtime_error(text);
    }
}

class Activation final : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IActivateAudioInterfaceCompletionHandler, FtmBase> {
public:
    HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    ~Activation() { CloseHandle(ready); }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT status = E_FAIL;
        ComPtr<IUnknown> value;
        result = operation->GetActivateResult(&status, &value);
        if (SUCCEEDED(result)) result = status;
        if (SUCCEEDED(result)) result = value.As(&client);
        SetEvent(ready);
        return S_OK;
    }
};

static void integer(std::ofstream& file, uint32_t value, int bytes) {
    for (int i = 0; i < bytes; ++i) file.put(static_cast<char>((value >> (i * 8)) & 255));
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 4) { std::cerr << "Usage: capture_process PID SECONDS OUTPUT.wav\n"; return 2; }
    try {
        const DWORD pid = std::stoul(argv[1]);
        const double seconds = std::stod(argv[2]);
        if (!pid || seconds <= 0 || seconds > 600) throw std::runtime_error("Invalid capture bounds");
        check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM initialization");
        AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
        parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        parameters.ProcessLoopbackParams.TargetProcessId = pid;
        parameters.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        PROPVARIANT blob{};
        blob.vt = VT_BLOB;
        blob.blob.cbSize = sizeof(parameters);
        blob.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);
        auto activation = Make<Activation>();
        ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
        check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
                                         &blob, activation.Get(), &operation), "Process loopback activation");
        if (WaitForSingleObject(activation->ready, 10000) != WAIT_OBJECT_0) throw std::runtime_error("Audio activation timeout");
        check(activation->result, "Audio activation callback");
        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 2; format.nSamplesPerSec = 44100; format.wBitsPerSample = 16;
        format.nBlockAlign = 4; format.nAvgBytesPerSec = 176400;
        check(activation->client->Initialize(AUDCLNT_SHAREMODE_SHARED,
              AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
              0, 0, &format, nullptr), "Process capture initialization");
        ComPtr<IAudioCaptureClient> capture;
        check(activation->client->GetService(IID_PPV_ARGS(&capture)), "Capture service");
        std::ofstream file(argv[3], std::ios::binary);
        if (!file) throw std::runtime_error("Cannot open output WAV");
        file.write("RIFF", 4); integer(file, 0, 4); file.write("WAVEfmt ", 8); integer(file, 16, 4);
        integer(file, 1, 2); integer(file, 2, 2); integer(file, 44100, 4); integer(file, 176400, 4);
        integer(file, 4, 2); integer(file, 16, 2); file.write("data", 4); integer(file, 0, 4);
        check(activation->client->Start(), "Capture start");
        LARGE_INTEGER readyQpc, frequency; FILETIME readyUtc;
        QueryPerformanceFrequency(&frequency); QueryPerformanceCounter(&readyQpc);
        GetSystemTimePreciseAsFileTime(&readyUtc);
        ULARGE_INTEGER utc; utc.LowPart = readyUtc.dwLowDateTime; utc.HighPart = readyUtc.dwHighDateTime;
        double utcSeconds = (utc.QuadPart - 116444736000000000ULL) / 1e7;
        double qpc100ns = static_cast<double>(readyQpc.QuadPart) * 1e7 / frequency.QuadPart;
        std::cout << std::setprecision(17) << "{\"event\":\"ready\",\"pid\":" << pid
                  << ",\"sampleRate\":44100,\"channels\":2,\"readyUtcSeconds\":" << utcSeconds
                  << ",\"readyQpc100ns\":" << qpc100ns << "}" << std::endl;
        auto began = std::chrono::steady_clock::now();
        uint64_t framesWritten = 0, silentFrames = 0, gaps = 0, previousEnd = 0;
        struct Stamp { uint64_t frame, qpc, position; uint32_t count, flags; };
        std::vector<Stamp> stamps;
        unsigned discontinuities = 0, timestampErrors = 0;
        bool first = true;
        while (std::chrono::duration<double>(std::chrono::steady_clock::now() - began).count() < seconds) {
            UINT32 available = 0;
            check(capture->GetNextPacketSize(&available), "Next capture packet");
            while (available) {
                BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0; UINT64 position = 0, timestamp = 0;
                check(capture->GetBuffer(&data, &frames, &flags, &position, &timestamp), "Capture buffer");
                if (!first && (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY)) ++discontinuities;
                if (!first && position > previousEnd) {
                    auto missing = position - previousEnd;
                    if (missing > 44100 * 10) throw std::runtime_error("Unexpected capture timestamp gap");
                    std::vector<char> zero(static_cast<size_t>(missing) * 4, 0); file.write(zero.data(), zero.size());
                    framesWritten += missing; gaps += missing;
                }
                first = false; previousEnd = position + frames;
                if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ++timestampErrors;
                stamps.push_back({framesWritten, timestamp, position, frames, flags});
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    std::vector<char> zero(static_cast<size_t>(frames) * 4, 0); file.write(zero.data(), zero.size()); silentFrames += frames;
                } else file.write(reinterpret_cast<char*>(data), static_cast<size_t>(frames) * 4);
                framesWritten += frames;
                check(capture->ReleaseBuffer(frames), "Release capture buffer");
                check(capture->GetNextPacketSize(&available), "Next capture packet");
            }
            Sleep(2);
        }
        check(activation->client->Stop(), "Capture stop");
        uint32_t bytes = static_cast<uint32_t>(framesWritten * 4);
        file.seekp(4); integer(file, bytes + 36, 4); file.seekp(40); integer(file, bytes, 4); file.close();
        std::ofstream timing(std::wstring(argv[3]) + L".timing.json");
        timing << "{\"qpcUnitsPerSecond\":10000000,\"packets\":[";
        for (size_t i = 0; i < stamps.size(); ++i) {
            const auto& stamp = stamps[i]; if (i) timing << ',';
            timing << "{\"frame\":" << stamp.frame << ",\"qpc\":" << stamp.qpc << ",\"position\":" << stamp.position
                   << ",\"count\":" << stamp.count << ",\"flags\":" << stamp.flags << '}';
        }
        timing << "]}"; timing.close();
        std::cout << "{\"event\":\"complete\",\"frames\":" << framesWritten << ",\"silentFrames\":" << silentFrames
                  << ",\"gapFrames\":" << gaps << ",\"discontinuities\":" << discontinuities
                  << ",\"timestampErrors\":" << timestampErrors << "}" << std::endl;
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
