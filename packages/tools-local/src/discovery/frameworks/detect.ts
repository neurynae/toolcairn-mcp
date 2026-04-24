import type { Ecosystem, ProjectFramework } from '@toolcairn/types';
import type { DetectedTool } from '../types.js';

/**
 * Offline framework-detection map — primary signal is the engine batch-resolve
 * `categories` array; this is the fallback for tools not in the graph, or when
 * the engine is unreachable.
 */
const FALLBACK: Record<Ecosystem, Record<string, string>> = {
  npm: {
    next: 'Next.js',
    react: 'React',
    vue: 'Vue',
    nuxt: 'Nuxt',
    svelte: 'Svelte',
    '@sveltejs/kit': 'SvelteKit',
    astro: 'Astro',
    'solid-js': 'SolidJS',
    express: 'Express',
    fastify: 'Fastify',
    koa: 'Koa',
    hono: 'Hono',
    '@nestjs/core': 'NestJS',
    remix: 'Remix',
    '@remix-run/react': 'Remix',
    gatsby: 'Gatsby',
    electron: 'Electron',
    'react-native': 'React Native',
    expo: 'Expo',
    angular: 'Angular',
    '@angular/core': 'Angular',
    turbo: 'Turborepo',
    nx: 'Nx',
    vite: 'Vite',
    webpack: 'Webpack',
  },
  pypi: {
    django: 'Django',
    flask: 'Flask',
    fastapi: 'FastAPI',
    starlette: 'Starlette',
    pyramid: 'Pyramid',
    tornado: 'Tornado',
    aiohttp: 'aiohttp',
    litestar: 'Litestar',
    sanic: 'Sanic',
    bottle: 'Bottle',
    quart: 'Quart',
    celery: 'Celery',
    streamlit: 'Streamlit',
    gradio: 'Gradio',
    torch: 'PyTorch',
    tensorflow: 'TensorFlow',
    transformers: 'Transformers',
    langchain: 'LangChain',
    'llama-index': 'LlamaIndex',
  },
  cargo: {
    'actix-web': 'Actix Web',
    axum: 'Axum',
    rocket: 'Rocket',
    warp: 'Warp',
    tide: 'Tide',
    poem: 'Poem',
    salvo: 'Salvo',
    leptos: 'Leptos',
    dioxus: 'Dioxus',
    yew: 'Yew',
    tauri: 'Tauri',
    bevy: 'Bevy',
    tokio: 'Tokio',
  },
  go: {
    'github.com/gin-gonic/gin': 'Gin',
    'github.com/labstack/echo': 'Echo',
    'github.com/labstack/echo/v4': 'Echo',
    'github.com/gofiber/fiber': 'Fiber',
    'github.com/gofiber/fiber/v2': 'Fiber',
    'github.com/beego/beego': 'Beego',
    'github.com/go-chi/chi': 'Chi',
    'github.com/gorilla/mux': 'Gorilla',
    'github.com/revel/revel': 'Revel',
  },
  rubygems: {
    rails: 'Ruby on Rails',
    sinatra: 'Sinatra',
    hanami: 'Hanami',
    roda: 'Roda',
    rack: 'Rack',
  },
  maven: {
    'org.springframework.boot:spring-boot-starter': 'Spring Boot',
    'org.springframework.boot:spring-boot-starter-web': 'Spring Boot',
    'io.quarkus:quarkus-core': 'Quarkus',
    'io.micronaut:micronaut-core': 'Micronaut',
    'io.vertx:vertx-core': 'Vert.x',
    'com.google.inject:guice': 'Guice',
  },
  gradle: {
    'org.springframework.boot:spring-boot-starter': 'Spring Boot',
    'io.quarkus:quarkus-core': 'Quarkus',
    'io.micronaut:micronaut-core': 'Micronaut',
    'io.ktor:ktor-server-core': 'Ktor',
  },
  composer: {
    'laravel/framework': 'Laravel',
    'symfony/framework-bundle': 'Symfony',
    'cakephp/cakephp': 'CakePHP',
    'yiisoft/yii2': 'Yii',
    'slim/slim': 'Slim',
  },
  hex: {
    phoenix: 'Phoenix',
    ecto: 'Ecto',
    nerves: 'Nerves',
    ash: 'Ash',
  },
  pub: {
    flutter: 'Flutter',
    flutter_bloc: 'Flutter BLoC',
  },
  nuget: {
    'Microsoft.AspNetCore.App': 'ASP.NET Core',
    'Microsoft.AspNetCore': 'ASP.NET Core',
    'Microsoft.EntityFrameworkCore': 'Entity Framework Core',
    'Microsoft.NET.Sdk.Web': 'ASP.NET Core',
    Avalonia: 'Avalonia',
    MAUI: '.NET MAUI',
  },
  'swift-pm': {
    vapor: 'Vapor',
    kitura: 'Kitura',
    perfect: 'Perfect',
  },
};

/** Categories that indicate "this IS a framework" when returned by batch-resolve. */
const FRAMEWORK_CATEGORIES = new Set([
  'framework',
  'web-framework',
  'ui-framework',
  'meta-framework',
  'backend-framework',
  'frontend-framework',
  'mobile-framework',
]);

export interface BatchResolveResult {
  input: { name: string; ecosystem: Ecosystem };
  matched: boolean;
  tool?: {
    canonical_name: string;
    github_url?: string;
    categories: string[];
    /** v1.2+ enrichment — populated by batch-resolve's Memgraph pass. */
    description?: string | null;
    license?: string | null;
    homepage_url?: string | null;
    docs?: {
      readme_url?: string | null;
      docs_url?: string | null;
      api_url?: string | null;
      changelog_url?: string | null;
    };
    package_managers?: Array<{
      registry: string;
      packageName: string;
      installCommand?: string;
      weeklyDownloads?: number;
    }>;
  };
}

/**
 * Build the frameworks[] array for config.json.
 *
 * Primary signal: batch-resolve response carries a `categories` array with a
 * framework-like tag — use graph-resolved canonical name and tag source='graph'.
 * Fallback (offline or non-indexed): check FALLBACK[ecosystem][name] and tag
 * source='local'.
 *
 * De-duplicates by (framework_name, workspace). Dev-dependencies are ignored
 * (a dev-dep is almost never "the framework").
 */
export function detectFrameworks(
  tools: DetectedTool[],
  resolved: Map<string, BatchResolveResult>,
): ProjectFramework[] {
  const out: ProjectFramework[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    if (tool.section === 'dev') continue;
    const workspace = tool.workspace_path || '.';
    const resolvedKey = `${tool.ecosystem}:${tool.name}`;
    const graphMatch = resolved.get(resolvedKey);

    let frameworkName: string | null = null;
    let source: 'graph' | 'local' = 'local';

    if (graphMatch?.matched && graphMatch.tool) {
      const categories = graphMatch.tool.categories ?? [];
      if (categories.some((c) => FRAMEWORK_CATEGORIES.has(c.toLowerCase()))) {
        frameworkName = graphMatch.tool.canonical_name;
        source = 'graph';
      }
    }

    if (!frameworkName) {
      const localName = FALLBACK[tool.ecosystem]?.[tool.name];
      if (localName) {
        frameworkName = localName;
        source = 'local';
      }
    }

    if (!frameworkName) continue;
    const dedupeKey = `${frameworkName}:${workspace}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      name: frameworkName,
      ecosystem: tool.ecosystem,
      workspace,
      source,
    });
  }

  return out;
}
