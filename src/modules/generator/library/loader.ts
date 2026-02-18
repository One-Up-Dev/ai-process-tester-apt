import { join } from "node:path";
import { TestDefinitionSchema } from "@apt/lib/schema";
import type { SystemType, TestCategory, TestDefinition, TestDimension } from "@apt/lib/types";
import { parse } from "yaml";

export class TestLibrary {
  private tests: Map<string, TestDefinition> = new Map();

  /**
   * Recursively load all .yaml files from a directory,
   * parse them with the yaml package, validate with Zod,
   * and store in the internal Map.
   */
  async loadDirectory(dir: string): Promise<void> {
    const glob = new Bun.Glob("**/*.yaml");

    for await (const path of glob.scan({ cwd: dir, absolute: false })) {
      const fullPath = join(dir, path);
      const file = Bun.file(fullPath);
      const content = await file.text();

      let raw: unknown;
      try {
        raw = parse(content);
      } catch (err) {
        throw new Error(
          `Failed to parse YAML file ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const result = TestDefinitionSchema.safeParse(raw);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(`Validation failed for ${fullPath}:\n${issues}`);
      }

      const test = result.data as TestDefinition;

      if (this.tests.has(test.id)) {
        throw new Error(
          `Duplicate test ID "${test.id}" found in ${fullPath}. Already loaded from another file.`,
        );
      }

      this.tests.set(test.id, test);
    }
  }

  /**
   * Load the built-in test library from the project root library/ directory.
   */
  async loadBuiltIn(): Promise<void> {
    const libraryDir = join(import.meta.dir, "..", "..", "..", "..", "library");
    await this.loadDirectory(libraryDir);
  }

  /** Return all loaded tests. */
  getAll(): TestDefinition[] {
    return [...this.tests.values()];
  }

  /** Filter tests by system type compatibility. */
  getBySystemType(type: SystemType): TestDefinition[] {
    return this.getAll().filter((t) => t.system_types.includes(type));
  }

  /** Filter tests by dimension. */
  getByDimension(dim: TestDimension): TestDefinition[] {
    return this.getAll().filter((t) => t.dimension === dim);
  }

  /** Filter tests by category. */
  getByCategory(cat: TestCategory): TestDefinition[] {
    return this.getAll().filter((t) => t.category === cat);
  }

  /** Get a single test by its ID. */
  getById(id: string): TestDefinition | undefined {
    return this.tests.get(id);
  }

  /** Filter tests that have at least one of the specified tags. */
  getByTags(tags: string[]): TestDefinition[] {
    return this.getAll().filter((t) => tags.some((tag) => t.tags.includes(tag)));
  }

  /** Return the total number of loaded tests. */
  count(): number {
    return this.tests.size;
  }
}
