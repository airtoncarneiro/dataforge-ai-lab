import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AUTHORITY_BOUNDARIES,
  PHASE_POLICY_SECTIONS,
  REQUIRED_POLICY_MARKERS,
  SHARED_POLICY_SECTIONS,
  TUTOR_LIFECYCLE,
  TUTOR_POLICY_SOURCE_PATH,
  TUTOR_POLICY_VERSION,
} from "./policy-manifest.js";
import { deepFreeze, fail } from "./utils.js";

const DEFAULT_SOURCE_URL = new URL("../../docs/TUTOR_POLICY.md", import.meta.url);

function parseSections(markdown) {
  const sections = new Map();
  let currentTitle = null;
  let currentLines = [];

  const flush = () => {
    if (currentTitle !== null) {
      sections.set(currentTitle, currentLines.join("\n").trim());
    }
  };

  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      flush();
      currentTitle = heading[1];
      currentLines = [];
    } else if (currentTitle !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

function sectionRecord(title, sections) {
  const content = sections.get(title);
  if (!content) {
    fail("invalid_policy_source", `A seção obrigatória '${title}' não existe na Tutor Policy.`);
  }
  return deepFreeze({ title, content });
}

function assertPolicySource(markdown) {
  const title = /^# Tutor Policy v([^\s]+)\s*$/mu.exec(markdown);
  const actualVersion = title ? `tutor-policy-v${title[1]}` : null;
  if (actualVersion !== TUTOR_POLICY_VERSION) {
    fail(
      "policy_version_mismatch",
      `A Tutor Policy deve declarar a versão ${TUTOR_POLICY_VERSION}.`,
    );
  }
  for (const marker of REQUIRED_POLICY_MARKERS) {
    if (!markdown.includes(marker)) {
      fail("invalid_policy_source", "A Tutor Policy não contém todos os princípios obrigatórios.");
    }
  }
}

export async function loadTutorPolicy({ sourceUrl = DEFAULT_SOURCE_URL } = {}) {
  const markdown = await readFile(sourceUrl, "utf8");
  assertPolicySource(markdown);
  const sections = parseSections(markdown);
  const phaseSections = {};
  for (const [phase, titles] of Object.entries(PHASE_POLICY_SECTIONS)) {
    phaseSections[phase] = titles.map((title) => sectionRecord(title, sections));
  }

  return deepFreeze({
    version: TUTOR_POLICY_VERSION,
    source: {
      path: TUTOR_POLICY_SOURCE_PATH,
      sha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
    },
    lifecycle: [...TUTOR_LIFECYCLE],
    authority_boundaries: [...AUTHORITY_BOUNDARIES],
    shared_sections: SHARED_POLICY_SECTIONS.map((title) => sectionRecord(title, sections)),
    phase_sections: phaseSections,
  });
}
