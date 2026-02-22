export type DocumentStatus =
  | 'in_force'
  | 'amended'
  | 'repealed'
  | 'not_yet_in_force';

export interface TargetLaw {
  order: string;
  id: string;
  reference: string;
  titleUkFallback: string;
  shortName: string;
  titleEnFallback: string;
  description: string;
  articleFilter?: string[];
}

export interface ParseOptions {
  extractDefinitions?: boolean;
}

export interface ParsedProvision {
  provision_ref: string;
  chapter?: string;
  section: string;
  title: string;
  content: string;
}

export interface ParsedDefinition {
  term: string;
  definition: string;
  source_provision?: string;
}

export interface ParsedAct {
  id: string;
  type: 'statute';
  title: string;
  title_en: string;
  short_name: string;
  status: DocumentStatus;
  issued_date?: string;
  in_force_date?: string;
  url: string;
  description: string;
  provisions: ParsedProvision[];
  definitions: ParsedDefinition[];
}

interface WorkingArticle {
  section: string;
  heading: string;
  lines: string[];
}

const ENTITY_MAP: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  shy: '',
};

const HYPHEN_VARIANTS = /[‐‑‒–—]/g;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&([a-zA-Z]+);/g, (_, name: string) => ENTITY_MAP[name] ?? `&${name};`)
    .replace(/&#(\d+);/g, (_, num: string) => {
      const cp = Number.parseInt(num, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function formatDate(raw: string): string {
  const m = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return raw;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function isEnglishLike(text: string): boolean {
  if (!text) return false;
  const hasCyrillic = /[\u0400-\u04FF]/u.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  return hasLatin && !hasCyrillic;
}

function extractPageTitle(html: string): string {
  const h1 = html.match(/<div class="page-header"><h1>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return normalizeWhitespace(htmlToText(h1[1]));

  const title = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!title?.[1]) return '';
  const trimmed = htmlToText(title[1]);
  return trimmed.replace(/\s*\|\s*від\s+\d{2}\.\d{2}\.\d{4}.*$/, '').trim();
}

function resolveTitle(extracted: string, fallback: string): string {
  if (!extracted) return fallback;
  if (extracted.includes('...') || extracted.includes('…')) return fallback;
  return extracted;
}

function extractIssuedDate(html: string): string | undefined {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const m = decodeHtmlEntities(title).match(/від\s+(\d{2}\.\d{2}\.\d{4})/);
  return m?.[1] ? formatDate(m[1]) : undefined;
}

function extractStatus(html: string): DocumentStatus {
  if (/<span class="valid">/i.test(html)) return 'in_force';
  if (/<span class="invalid">/i.test(html)) return 'repealed';
  if (/<span class="(?:notvalid|obsolete|disabled)">/i.test(html)) return 'repealed';

  const statusSpan = html.match(
    /Document[\s\S]{0,200}<span class="([^"]+)">([^<]+)<\/span>/i,
  );
  if (statusSpan) {
    const cls = statusSpan[1].toLowerCase();
    const text = statusSpan[2].toLowerCase();
    if (cls.includes('valid') || text.includes('valid') || text.includes('чинний')) {
      return 'in_force';
    }
    if (text.includes('repealed') || text.includes('нечинний')) {
      return 'repealed';
    }
  }

  const lower = html.toLowerCase();
  if (lower.includes('не набрав чинності') || lower.includes('not yet in force')) {
    return 'not_yet_in_force';
  }

  return 'in_force';
}

function extractArticleArea(html: string): string {
  const articleContainer = /<div[^>]*\bid\s*=\s*(?:"article"|'article'|article)(?=[\s>])[^>]*>/i.exec(html);
  if (!articleContainer || articleContainer.index < 0) {
    throw new Error('Could not find article body in /print HTML');
  }

  let area = html.slice(articleContainer.index);
  const markers = [
    '<h2 class=hdr1>Публікації документа',
    '<h2 class=hdr1>Publications of the document',
    '<h2 class=hdr1>Публикации документа',
  ];

  for (const marker of markers) {
    const idx = area.indexOf(marker);
    if (idx >= 0) {
      area = area.slice(0, idx);
      break;
    }
  }

  return area
    .replace(
      /<span[^>]*style="font-size:0px"[^>]*>\s*-\s*<\/span>/gi,
      '-',
    )
    .replace(/<a[^>]*name="[^"]*"[^>]*><\/a>/gi, '');
}

function buildProvision(section: string, heading: string, lines: string[]): ParsedProvision | null {
  const headingNormalized = normalizeWhitespace(heading);
  let content = normalizeWhitespace(lines.join('\n'));

  // Keep placeholder articles that are explicitly marked as removed/repealed
  // so section numbering remains complete in downstream queries.
  if (
    !content &&
    /(?:виключено|втратив чинність)/iu.test(headingNormalized)
  ) {
    content = headingNormalized.replace(/^\{|\}$/g, '').trim();
  }

  if (!content) return null;

  const normalizedSection = section.replace(HYPHEN_VARIANTS, '-');
  const provisionRef = `art${normalizedSection}`;
  const title = headingNormalized
    ? `Стаття ${normalizedSection}. ${headingNormalized}`.trim()
    : `Стаття ${normalizedSection}`;

  return {
    provision_ref: provisionRef,
    section: normalizedSection,
    title,
    content,
  };
}

function extractDefinitions(provisions: ParsedProvision[]): ParsedDefinition[] {
  const definitions: ParsedDefinition[] = [];
  const seen = new Set<string>();

  const addDefinition = (
    term: string,
    definition: string,
    sourceProvision: string,
  ): void => {
    const normalizedTerm = normalizeWhitespace(term).replace(/^["'«»]+|["'«»]+$/g, '');
    const normalizedDef = normalizeWhitespace(definition).replace(/[;.]$/, '').trim();

    if (normalizedTerm.length < 2 || normalizedTerm.length > 160) return;
    if (normalizedDef.length < 8) return;

    const key = normalizedTerm.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    definitions.push({
      term: normalizedTerm,
      definition: normalizedDef,
      source_provision: sourceProvision,
    });
  };

  for (const provision of provisions) {
    const isDefinitionArticle =
      /визначення|термін/i.test(provision.title) ||
      /терміни вживаються|визначено таким чином/i.test(provision.content);
    if (!isDefinitionArticle) continue;

    const lines = provision.content.split('\n');
    for (const line of lines) {
      const m = line.match(
        /^\s*\d+\s*(?:-\s*\d+)?\)\s*([^;]{2,140}?)\s*[—-]\s*(.+)$/u,
      );
      if (!m) continue;

      if (/далі\s*-?/iu.test(m[1])) continue;
      addDefinition(m[1], m[2], provision.provision_ref);
    }
  }

  return definitions;
}

export function extractEnglishTitle(htmlEn: string): string | undefined {
  const title = extractPageTitle(htmlEn);
  return isEnglishLike(title) ? title : undefined;
}

export function parseLawPrintHtml(
  printHtml: string,
  law: TargetLaw,
  titleEn?: string,
  statusHtml?: string,
  options?: ParseOptions,
): ParsedAct {
  const title = resolveTitle(extractPageTitle(printHtml), law.titleUkFallback);
  const issuedDate = extractIssuedDate(printHtml);
  const status = extractStatus(statusHtml ?? printHtml);
  const articleArea = extractArticleArea(printHtml);

  const paragraphRegex = /<(?:p|pre)\b[^>]*>([\s\S]*?)<\/(?:p|pre)>/gi;
  const articles: ParsedProvision[] = [];
  let current: WorkingArticle | null = null;
  let match: RegExpExecArray | null;

  while ((match = paragraphRegex.exec(articleArea)) !== null) {
    let text = htmlToText(match[1]);
    if (!text) continue;

    // Skip amendment/editorial notes wrapped in braces.
    if (text.startsWith('{') && text.endsWith('}')) continue;

    text = text
      .replace(
        /^Стаття\s+(\d+)\s*\.\s*-\s*(\d+)\s*\.\s*/u,
        'Стаття $1-$2. ',
      )
      .replace(/^Стаття\s+(\d+)\s*-\s*(\d+)\s*\.\s*/u, 'Стаття $1-$2. ');

    const headingMatch = text.match(
      /^Стаття\s+([0-9]+(?:[-‑‒–—][0-9]+)?)\s*\.?\s*(.*)$/u,
    );
    if (headingMatch) {
      if (current) {
        const provision = buildProvision(
          current.section,
          current.heading,
          current.lines,
        );
        if (provision) articles.push(provision);
      }

      current = {
        section: headingMatch[1].replace(HYPHEN_VARIANTS, '-'),
        heading: headingMatch[2].trim(),
        lines: [],
      };
      continue;
    }

    if (!current) continue;

    // Skip editorial annotations even when they are not fully braced.
    if (
      /^(\{.*\}|Президент України|Із змінами, внесеними|Розділ\s+[IVXLC\d]+|КНИГА\s+[IVXLC\d]+|м\.\s*Київ|№\s*\d)/u.test(
        text,
      )
    ) {
      continue;
    }

    current.lines.push(text);
  }

  if (current) {
    const provision = buildProvision(current.section, current.heading, current.lines);
    if (provision) articles.push(provision);
  }

  if (articles.length === 0) {
    const fullBody = normalizeWhitespace(htmlToText(articleArea));
    if (fullBody) {
      articles.push({
        provision_ref: 'art0',
        section: '0',
        title: 'Стаття 0. Текст документа',
        content: fullBody,
      });
    }
  }

  const filteredProvisions = law.articleFilter
    ? articles.filter(p => law.articleFilter!.includes(p.section))
    : articles;

  const definitions =
    options?.extractDefinitions === false
      ? []
      : extractDefinitions(filteredProvisions);
  const titleEnResolved = titleEn?.trim() || law.titleEnFallback;

  return {
    id: law.id,
    type: 'statute',
    title,
    title_en: titleEnResolved,
    short_name: law.shortName,
    status,
    issued_date: issuedDate,
    url: `https://zakon.rada.gov.ua/laws/show/${law.reference}`,
    description: law.description,
    provisions: filteredProvisions,
    definitions,
  };
}

export function slugFromReference(reference: string): string {
  const decoded = safeDecodeURIComponent(reference);
  return decoded
    .toLowerCase()
    .replace(/[\/\s]+/g, '-')
    .replace(/[^a-z0-9\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeReference(reference: string): string {
  return safeDecodeURIComponent(reference)
    .normalize('NFC')
    .replace(/\s+/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .toLowerCase();
}

const CURATED_BY_REFERENCE = new Map<string, TargetLaw>();

export function resolveKnownLawByReference(reference: string): TargetLaw | undefined {
  if (CURATED_BY_REFERENCE.size === 0) {
    for (const law of TARGET_LAWS) {
      CURATED_BY_REFERENCE.set(normalizeReference(law.reference), law);
    }
  }
  return CURATED_BY_REFERENCE.get(normalizeReference(reference));
}

export function buildGenericTargetLaw(reference: string, order: string): TargetLaw {
  const known = resolveKnownLawByReference(reference);
  if (known) {
    return {
      ...known,
      order,
      articleFilter: undefined,
    };
  }

  const slug = slugFromReference(reference);

  const decodedReference = safeDecodeURIComponent(reference);

  return {
    order,
    id: `ua-law-${slug}`,
    reference,
    titleUkFallback: `Закон України (${decodedReference})`,
    shortName: decodedReference,
    titleEnFallback: '',
    description:
      'Official legislative act of Ukraine ingested from the Verkhovna Rada legal portal.',
  };
}

export const TARGET_LAWS: TargetLaw[] = [
  {
    order: '01',
    id: 'ua-personal-data-protection',
    reference: '2297-17',
    titleUkFallback: 'Про захист персональних даних',
    shortName: 'ЗУ ПД',
    titleEnFallback: 'On Protection of Personal Data',
    description:
      'Framework statute governing personal data processing, data subject rights, and supervisory oversight in Ukraine.',
  },
  {
    order: '02',
    id: 'ua-cybersecurity',
    reference: '2163-19',
    titleUkFallback: 'Про основні засади забезпечення кібербезпеки України',
    shortName: 'ЗУ Кібербезпека',
    titleEnFallback: 'On the Basic Principles of Cybersecurity in Ukraine',
    description:
      'Core cybersecurity law defining national cybersecurity actors, coordination, and critical cyber protection measures.',
  },
  {
    order: '03',
    id: 'ua-electronic-communications',
    reference: '1089-20',
    titleUkFallback: 'Про електронні комунікації',
    shortName: 'ЗУ ЕК',
    titleEnFallback: 'On Electronic Communications',
    description:
      'Comprehensive regulation of electronic communications networks, services, users, and regulatory powers.',
  },
  {
    order: '04',
    id: 'ua-electronic-commerce',
    reference: '675-19',
    titleUkFallback: 'Про електронну комерцію',
    shortName: 'ЗУ Е-комерція',
    titleEnFallback: 'On Electronic Commerce',
    description:
      'Rules for electronic transactions, electronic contracts, and legal validity of digital commercial interactions.',
  },
  {
    order: '05',
    id: 'ua-electronic-trust-services',
    reference: '2155-19',
    titleUkFallback: 'Про електронну ідентифікацію та електронні довірчі послуги',
    shortName: 'ЗУ ЕДП',
    titleEnFallback:
      'On Electronic Identification and Electronic Trust Services',
    description:
      'Law regulating electronic identification, trust services, qualified signatures, and trust service supervision.',
  },
  {
    order: '06',
    id: 'ua-access-public-information',
    reference: '2939-17',
    titleUkFallback: 'Про доступ до публічної інформації',
    shortName: 'ЗУ ДПІ',
    titleEnFallback: 'On Access to Public Information',
    description:
      'Establishes transparency obligations, access procedures, and remedies for denial of public information access.',
  },
  {
    order: '07',
    id: 'ua-criminal-code-cybercrime',
    reference: '2341-14',
    titleUkFallback: 'Кримінальний кодекс України',
    shortName: 'ККУ (кіберзлочини)',
    titleEnFallback: 'Criminal Code of Ukraine (cybercrime articles)',
    description:
      'Selected cybercrime provisions of the Criminal Code related to unauthorized access, interference, and malware offences.',
    articleFilter: ['361', '361-1', '361-2', '362', '363', '363-1'],
  },
  {
    order: '08',
    id: 'ua-critical-infrastructure',
    reference: '1882-20',
    titleUkFallback: 'Про критичну інфраструктуру',
    shortName: 'ЗУ КІ',
    titleEnFallback: 'On Critical Infrastructure',
    description:
      'Defines legal and institutional framework for protection, resilience, and categorization of critical infrastructure.',
  },
  {
    order: '09',
    id: 'ua-information-protection-systems',
    reference: '80/94-%D0%B2%D1%80',
    titleUkFallback: 'Про захист інформації в інформаційно-комунікаційних системах',
    shortName: 'ЗУ Захист ІТС',
    titleEnFallback:
      'On Protection of Information in Information and Communication Systems',
    description:
      'Foundational law for technical and organizational protection of information in information systems.',
  },
  {
    order: '10',
    id: 'ua-competition-trade-secrets',
    reference: '236/96-%D0%B2%D1%80',
    titleUkFallback: 'Про захист від недобросовісної конкуренції',
    shortName: 'ЗУ Недобросовісна конкуренція',
    titleEnFallback: 'On Protection against Unfair Competition',
    description:
      'Contains rules on unfair competition including unlawful collection and disclosure of commercial secrets.',
  },
];
