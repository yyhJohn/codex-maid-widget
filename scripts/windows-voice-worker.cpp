// Build against the headers from the same whisper.cpp release as whisper.dll.
// stdin: little-endian byte count (highest bit selects the final pass), then PCM.
// stdout: a ready marker, then length-prefixed UTF-8 transcripts for each request.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include "whisper.h"
#include "ggml-backend.h"

namespace {
constexpr std::uint32_t ready_marker = 0x564F4943;
constexpr std::uint32_t final_flag = 0x80000000;
constexpr std::uint32_t error_marker = 0xffffffff;
constexpr std::uint32_t max_bytes = 60 * WHISPER_SAMPLE_RATE * sizeof(std::int16_t);
constexpr std::size_t max_text = 24000;

template<class Function>
Function load(HMODULE library, const char* name) {
    const auto address = GetProcAddress(library, name);
    if (!address) throw std::runtime_error(name);
    return reinterpret_cast<Function>(address);
}

std::string utf8(const wchar_t* argument) {
    const int size = static_cast<int>(std::wcslen(argument));
    const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argument, size, nullptr, 0, nullptr, nullptr);
    if (!bytes) throw std::runtime_error("invalid model path");
    std::string output(bytes, '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argument, size, output.data(), bytes, nullptr, nullptr)) {
        throw std::runtime_error("cannot encode model path");
    }
    return output;
}

bool reply(std::uint32_t length, const char* text = nullptr) {
    return std::fwrite(&length, sizeof(length), 1, stdout) == 1 &&
        (!text || std::fwrite(text, 1, length, stdout) == length) && std::fflush(stdout) == 0;
}
}

int wmain(int argc, wchar_t** argv) {
    const bool cpu = argc == 4 && std::wcscmp(argv[3], L"cpu") == 0;
    if (argc != 3 && !cpu) return 2;
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);

    try {
        const auto model = utf8(argv[1]);
        const auto vad = utf8(argv[2]);
        const auto search = LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32;
        const auto ggml = LoadLibraryExW(L"ggml.dll", nullptr, search);
        const auto whisper = LoadLibraryExW(L"whisper.dll", nullptr, search);
        if (!ggml || !whisper) throw std::runtime_error("cannot load the bundled speech engine");
        load<decltype(&ggml_backend_load_all)>(ggml, "ggml_backend_load_all")();
        const auto context_params = load<decltype(&whisper_context_default_params)>(whisper, "whisper_context_default_params");
        const auto init = load<decltype(&whisper_init_from_file_with_params)>(whisper, "whisper_init_from_file_with_params");
        const auto release = load<decltype(&whisper_free)>(whisper, "whisper_free");
        const auto default_params = load<decltype(&whisper_full_default_params)>(whisper, "whisper_full_default_params");
        const auto run = load<decltype(&whisper_full)>(whisper, "whisper_full");
        const auto segment_count = load<decltype(&whisper_full_n_segments)>(whisper, "whisper_full_n_segments");
        const auto segment_text = load<decltype(&whisper_full_get_segment_text)>(whisper, "whisper_full_get_segment_text");

        auto context_options = context_params();
        context_options.use_gpu = !cpu;
        context_options.flash_attn = true;
        const std::unique_ptr<whisper_context, decltype(release)> context(init(model.c_str(), context_options), release);
        if (!context) throw std::runtime_error("cannot initialize the speech model");
        if (!reply(ready_marker)) return 3;

        std::vector<std::int16_t> pcm;
        std::vector<float> samples;
        for (std::uint32_t frame; std::fread(&frame, sizeof(frame), 1, stdin) == 1;) {
            const bool final_pass = (frame & final_flag) != 0;
            const auto bytes = frame & ~final_flag;
            if (!bytes || bytes > max_bytes || bytes % sizeof(std::int16_t)) return 2;
            pcm.resize(bytes / sizeof(std::int16_t));
            if (std::fread(pcm.data(), 1, bytes, stdin) != bytes) return 2;
            samples.assign(pcm.begin(), pcm.end());
            for (auto& sample : samples) sample /= 32768.0f;

            auto params = default_params(final_pass ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
            params.n_threads = cpu ? 4 : 6;
            params.language = "zh";
            params.no_context = true;
            if (!final_pass) {
                const auto frames = static_cast<int>(samples.size() / (WHISPER_SAMPLE_RATE / 50));
                params.audio_ctx = std::clamp(frames + 96, 128, 1500);
            }
            params.print_realtime = false;
            params.print_progress = false;
            params.print_timestamps = false;
            params.suppress_nst = true;
            params.temperature_inc = 0;
            params.greedy.best_of = 1;
            params.beam_search.beam_size = 5;
            params.vad = true;
            params.vad_model_path = vad.c_str();
            params.vad_params.min_speech_duration_ms = 180;
            params.vad_params.min_silence_duration_ms = 320;
            params.vad_params.speech_pad_ms = 100;
            params.vad_params.samples_overlap = 0;

            if (run(context.get(), params, samples.data(), static_cast<int>(samples.size())) != 0) {
                if (!reply(error_marker)) return 3;
                continue;
            }
            std::string text;
            for (int i = 0, count = segment_count(context.get()); i < count; ++i) {
                if (const auto part = segment_text(context.get(), i)) text += part;
            }
            if (text.size() > max_text) {
                if (!reply(error_marker)) return 3;
            } else if (!reply(static_cast<std::uint32_t>(text.size()), text.data())) {
                return 3;
            }
        }
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 3;
    }
    return 0;
}
