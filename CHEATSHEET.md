# APT Cheatsheet

## Routes

| Provider | URL |
|---|---|
| Ollama (local) | `http://localhost:11434/v1/chat/completions` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |

## CLI

```bash
# Ollama (pas besoin d'auth)
bun run dev -- run --target http://localhost:11434/v1/chat/completions --model qwen2.5-coder:7b-instruct

# OpenRouter (clé dans .env OPENROUTER_API_KEY, ou --auth-token)
bun run dev -- run --target https://openrouter.ai/api/v1/chat/completions --model anthropic/claude-haiku-4.5

# Mode exhaustive (tous les tests, pas d'adaptive)
bun run dev -- run --target http://localhost:11434/v1/chat/completions --model qwen2.5-coder:7b-instruct --mode exhaustive

# Mode guidé (explications à chaque étape)
bun run dev -- run --target http://localhost:11434/v1/chat/completions --model qwen2.5-coder:7b-instruct --guided

# Init config (crée apt.config.yaml)
bun run dev -- init

# Voir un rapport existant
bun run dev -- report <evaluation-id>
```

## OpenRouter — Lister les modèles

```bash
# Tous les modèles
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq '.data[].id'

# Filtrer par provider
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq '.data[].id' | grep anthropic
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq '.data[].id' | grep openai
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq '.data[].id' | grep qwen
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq '.data[].id' | grep meta-llama
```

## Ollama — Gestion des modèles

```bash
# Lister les modèles installés
ollama list

# Télécharger un modèle
ollama pull qwen2.5-coder:7b-instruct

# Lancer un modèle (interactif)
ollama run qwen2.5-coder:7b-instruct

# Tester la connectivité
curl -s http://localhost:11434/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"qwen2.5-coder:7b-instruct","messages":[{"role":"user","content":"hi"}]}'
```

## Modèles courants

| Provider | Model ID | Notes |
|---|---|---|
| Anthropic | `anthropic/claude-opus-4.6` | Via OpenRouter, lent/cher |
| Anthropic | `anthropic/claude-sonnet-4.5` | Via OpenRouter |
| Anthropic | `anthropic/claude-sonnet-4` | Via OpenRouter |
| Anthropic | `anthropic/claude-haiku-4.5` | Via OpenRouter, rapide/pas cher |
| Anthropic | `anthropic/claude-3.5-haiku` | Via OpenRouter, legacy |
| OpenAI | `openai/gpt-4o` | Via OpenRouter |
| OpenAI | `openai/gpt-4o-mini` | Via OpenRouter, pas cher |
| Google | `google/gemini-2.5-flash` | Via OpenRouter |
| Qwen | `qwen2.5-coder:7b-instruct` | Ollama local |
| Llama | `meta-llama/llama-3.1-70b-instruct` | Via OpenRouter |

## Exemples complets

```bash
# Test rapide Haiku via OpenRouter (1 réplication, rapport HTML)
bun run dev -- run \
  --target https://openrouter.ai/api/v1/chat/completions \
  --model anthropic/claude-haiku-4.5 \
  --replications 1 --report html --output ./apt-reports

# Test Ollama local (mode exhaustif, 3 réplications)
bun run dev -- run \
  --target http://localhost:11434/v1/chat/completions \
  --model qwen2.5-coder:7b-instruct \
  --mode exhaustive --replications 3 --report html --output ./apt-reports

# Test guidé (interactif, explique chaque étape)
bun run dev -- run \
  --target http://localhost:11434/v1/chat/completions \
  --model qwen2.5-coder:7b-instruct --guided
```

## Dev

```bash
bun run typecheck    # TypeScript check
bun run lint         # Biome lint
bun test             # Tous les tests
```
