"""opencode2api — Python (OpenAI SDK) example.

    pip install openai
    python examples/python.py
"""

import os

from openai import OpenAI

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8787/v1")
KEY = os.environ.get("BRIDGE_API_KEY", "not-needed")

client = OpenAI(base_url=BASE, api_key=KEY)

model = client.models.list().data[0].id
print(f"model: {model}\n")

res = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Explain what an API gateway does in 2 sentences."}],
)
print(res.choices[0].message.content)

print("\n--- streaming ---")
stream = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Count from 1 to 5, one number per line."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
print()
