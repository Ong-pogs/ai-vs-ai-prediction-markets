# Security and credentials

Keep your API keys in a local `.env` file. Never commit `.env`, upload it in an issue, or include it in a screenshot. The repository contains only `.env.example` with placeholders.

The harness reads the keys from the file and hands each one only to the code that calls that service. They are never copied into the process environment, never logged, never written to a run folder, and never passed to the AI command lines it starts. Those command lines run with no tools and no settings, in an empty working folder.

The harness places paper orders only (`POST /v1/paper/orders`). It contains no code that builds, signs or submits a real order, and it needs no Polymarket or Kalshi key, seed phrase or funded account. Do not add any to its configuration. Predictefy does require a key with the trade scope for paper orders; if you would rather not keep such a key around, create one for this tool and revoke it afterwards.

The dashboard binds to `127.0.0.1` and is meant for your own computer. Do not expose it to the internet without adding authentication.

If you expose an API key, revoke or rotate it through your provider account. Removing it from the latest file alone does not remove it from Git history.

For a suspected vulnerability, use the repository's private vulnerability reporting option under **Security → Report a vulnerability**. Use synthetic values in reproductions. Ordinary bugs can be reported in public issues with redacted output.
