# Twitter Content Machine

A very small local app for rewriting public X/Twitter posts into one review-ready post for both X/Twitter and LinkedIn, plus two generated images.

It does not publish anything to X.

## Architecture

- X post fetching: the app reads public post text through X oEmbed.
- Research/context: the app performs a small targeted web search and keeps only a compact research brief.
- Text/content generation: NVIDIA NIM handles understanding the source, writing one punchy universal post for both X/Twitter and LinkedIn, and creating both image prompts.
- Image generation: OpenAI generates only Image 1 and Image 2.
- Image 2 text: the app adds the readable headline/supporting text itself after image generation, so the image model does not have to draw words.
- Review boundary: the app never publishes to X.

## Easy Start

1. Double-click:

```text
start-app.bat
```

2. Leave the black window open.
3. Open this in your browser:

```text
http://localhost:3000
```

## PowerShell Start

If double-clicking does not work:

1. Open PowerShell.
2. Go to this folder:

```powershell
cd "D:\bharat D drive\Dinesh Gupta\codex twitter"
```

3. Start the app:

```text
.\start-app.bat
```

## How to Use

1. Paste a public X/Twitter post URL.
2. Click **Generate**.
3. Wait while the app reads the source, checks compact web context, writes one universal post, and generates two images.
4. Review the final post.
5. Click **Copy** to copy the post.
6. Click **Save** above each image to download it.
7. Use **Regenerate Post**, **Regenerate Image 1**, or **Regenerate Image 2** when you only want to refresh one part.

## Notes

- The app uses your installed `twitter-content-rewriter` Codex skill instructions.
- The app uses your local `.env.local` file for `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_TEXT_MODEL`, and `OPENAI_API_KEY`.
- NVIDIA text model: `meta/llama-3.1-8b-instruct`.
- NVIDIA base URL: `https://integrate.api.nvidia.com/v1`.
- OpenAI is used only for the two generated images.
- The app verifies hashtags and adds a deterministic fallback if NVIDIA omits them.
- Image 1 is prompted as a premium editorial visual with no text.
- Image 2 is prompted as a text-free visual background, then the app overlays clean readable text.
- Regenerate Post reuses the cached source and research brief.
- Regenerate Image 1 and Regenerate Image 2 do not redo research or rewrite the post.
- The app does not publish to X.
- You stay in control and review everything first.
