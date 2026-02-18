import type {
  DetectionContext,
  DetectionResult,
  Detector,
  SystemType,
  TargetConfig,
} from "@apt/lib/types";

/** Patterns that map config file names/content to system types */
const CONFIG_PATTERNS: Array<{
  glob: string;
  type: SystemType;
  confidence: number;
  label: string;
}> = [
  { glob: "langchain.*", type: "rag", confidence: 0.7, label: "langchain config" },
  { glob: "llamaindex.*", type: "rag", confidence: 0.7, label: "llamaindex config" },
  { glob: "openai.*", type: "chatbot", confidence: 0.6, label: "openai config" },
  { glob: "anthropic.*", type: "chatbot", confidence: 0.6, label: "anthropic config" },
];

const CONTENT_PATTERNS: Array<{
  file: string;
  patterns: Array<{ match: RegExp; type: SystemType; confidence: number; label: string }>;
}> = [
  {
    file: "requirements.txt",
    patterns: [
      {
        match: /scikit-learn|sklearn/,
        type: "classifier",
        confidence: 0.7,
        label: "scikit-learn in requirements",
      },
      {
        match: /transformers/,
        type: "classifier",
        confidence: 0.7,
        label: "transformers in requirements",
      },
      { match: /langchain/, type: "rag", confidence: 0.7, label: "langchain in requirements" },
      {
        match: /llamaindex|llama.index|llama_index/,
        type: "rag",
        confidence: 0.7,
        label: "llamaindex in requirements",
      },
    ],
  },
  {
    file: "package.json",
    patterns: [
      { match: /langchain/, type: "rag", confidence: 0.7, label: "langchain in package.json" },
      { match: /llamaindex/, type: "rag", confidence: 0.7, label: "llamaindex in package.json" },
      { match: /openai/, type: "chatbot", confidence: 0.6, label: "openai in package.json" },
    ],
  },
  {
    file: "docker-compose.yml",
    patterns: [
      {
        match: /chromadb|chroma/,
        type: "rag",
        confidence: 0.7,
        label: "chromadb in docker-compose",
      },
      { match: /pinecone/, type: "rag", confidence: 0.7, label: "pinecone in docker-compose" },
      { match: /weaviate/, type: "rag", confidence: 0.7, label: "weaviate in docker-compose" },
    ],
  },
  {
    file: "docker-compose.yaml",
    patterns: [
      {
        match: /chromadb|chroma/,
        type: "rag",
        confidence: 0.7,
        label: "chromadb in docker-compose",
      },
      { match: /pinecone/, type: "rag", confidence: 0.7, label: "pinecone in docker-compose" },
      { match: /weaviate/, type: "rag", confidence: 0.7, label: "weaviate in docker-compose" },
    ],
  },
];

export class ConfigFileDetector implements Detector {
  name = "config-file";
  priority = 30;

  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? process.cwd();
  }

  async detect(_target: TargetConfig, _context: DetectionContext): Promise<DetectionResult> {
    const evidence: Record<string, unknown> = {};
    const hits: Array<{ type: SystemType; confidence: number; label: string }> = [];

    // 1. Check for config file names via glob patterns
    for (const pattern of CONFIG_PATTERNS) {
      try {
        const glob = new Bun.Glob(pattern.glob);
        const results: string[] = [];
        for await (const entry of glob.scan({ cwd: this.basePath, onlyFiles: true })) {
          results.push(entry);
        }
        if (results.length > 0) {
          hits.push({ type: pattern.type, confidence: pattern.confidence, label: pattern.label });
          evidence[pattern.label] = results;
        }
      } catch {
        // glob scan failed, skip
      }
    }

    // 2. Check file contents
    for (const fileDef of CONTENT_PATTERNS) {
      try {
        const filePath = `${this.basePath}/${fileDef.file}`;
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) continue;

        const content = await file.text();
        for (const pattern of fileDef.patterns) {
          if (pattern.match.test(content)) {
            hits.push({ type: pattern.type, confidence: pattern.confidence, label: pattern.label });
            evidence[pattern.label] = true;
          }
        }
      } catch {
        // file read failed, skip
      }
    }

    if (hits.length === 0) {
      return { system_type: null, confidence: 0, evidence: { found: false } };
    }

    // Aggregate: pick the most confident type, or the most frequent if tied
    const typeScores: Record<string, { total: number; max: number; count: number }> = {};
    for (const hit of hits) {
      if (!typeScores[hit.type]) {
        typeScores[hit.type] = { total: 0, max: 0, count: 0 };
      }
      typeScores[hit.type].total += hit.confidence;
      typeScores[hit.type].max = Math.max(typeScores[hit.type].max, hit.confidence);
      typeScores[hit.type].count++;
    }

    let bestType: SystemType = "custom";
    let bestScore = 0;
    for (const [type, score] of Object.entries(typeScores)) {
      const combined = score.max + score.count * 0.05; // slight boost for multiple signals
      if (combined > bestScore) {
        bestScore = combined;
        bestType = type as SystemType;
      }
    }

    const finalConfidence = Math.min(
      typeScores[bestType].max + (typeScores[bestType].count - 1) * 0.05,
      0.95,
    );

    evidence.hits = hits;
    return {
      system_type: bestType,
      confidence: Math.round(finalConfidence * 100) / 100,
      evidence,
    };
  }
}
