import type {
  DetectionContext,
  DetectionResult,
  Detector,
  SystemType,
  TargetConfig,
} from "@apt/lib/types";

interface DependencyRule {
  match: RegExp;
  type: SystemType;
  score: number;
  label: string;
}

const DEPENDENCY_RULES: DependencyRule[] = [
  // RAG frameworks
  { match: /langchain/, type: "rag", score: 0.7, label: "langchain" },
  { match: /llamaindex|llama.index|llama_index/, type: "rag", score: 0.7, label: "llamaindex" },
  // Vector stores (RAG boost)
  { match: /chromadb|chroma/, type: "rag", score: 0.15, label: "chromadb" },
  { match: /pinecone/, type: "rag", score: 0.15, label: "pinecone" },
  { match: /weaviate/, type: "rag", score: 0.15, label: "weaviate" },
  // Chatbot SDKs
  { match: /openai/, type: "chatbot", score: 0.6, label: "openai" },
  { match: /anthropic/, type: "chatbot", score: 0.6, label: "anthropic" },
  // Classifier / ML
  { match: /scikit-learn|sklearn/, type: "classifier", score: 0.7, label: "scikit-learn" },
  { match: /transformers/, type: "classifier", score: 0.7, label: "transformers" },
  // Agent frameworks
  { match: /autogen/, type: "agent", score: 0.7, label: "autogen" },
  { match: /crewai/, type: "agent", score: 0.7, label: "crewai" },
  // Web + ML combo -> classifier
  { match: /fastapi/, type: "classifier", score: 0.3, label: "fastapi" },
  { match: /flask/, type: "classifier", score: 0.3, label: "flask" },
];

const DEP_FILES = ["package.json", "requirements.txt", "pyproject.toml", "go.mod"] as const;

export class DependencyDetector implements Detector {
  name = "dependency";
  priority = 40;

  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? process.cwd();
  }

  async detect(_target: TargetConfig, _context: DetectionContext): Promise<DetectionResult> {
    const evidence: Record<string, unknown> = {};
    const typeScores: Record<string, number> = {};
    const matchedDeps: string[] = [];
    let filesFound = false;

    for (const depFile of DEP_FILES) {
      try {
        const filePath = `${this.basePath}/${depFile}`;
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) continue;

        filesFound = true;
        const content = await file.text();
        evidence[depFile] = true;

        for (const rule of DEPENDENCY_RULES) {
          if (rule.match.test(content)) {
            if (!typeScores[rule.type]) {
              typeScores[rule.type] = 0;
            }
            typeScores[rule.type] += rule.score;
            matchedDeps.push(rule.label);
          }
        }
      } catch {
        // File read failed, skip
      }
    }

    if (!filesFound || matchedDeps.length === 0) {
      return { system_type: null, confidence: 0, evidence: { found: false } };
    }

    // Find the best type
    let bestType: SystemType = "custom";
    let bestScore = 0;
    for (const [type, score] of Object.entries(typeScores)) {
      if (score > bestScore) {
        bestScore = score;
        bestType = type as SystemType;
      }
    }

    // Confidence: cap at 0.95
    const confidence = Math.min(bestScore, 0.95);

    evidence.matched_deps = matchedDeps;
    evidence.type_scores = typeScores;

    return {
      system_type: bestType,
      confidence: Math.round(confidence * 100) / 100,
      evidence,
    };
  }
}
