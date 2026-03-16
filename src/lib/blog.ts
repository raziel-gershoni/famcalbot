import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const contentDir = path.join(process.cwd(), 'content', 'blog');

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  author: string;
  order: number;
  coverImage?: string;
  tags: string[];
  content: string;
}

export function getAllPosts(locale: string): Omit<BlogPost, 'content'>[] {
  if (!fs.existsSync(contentDir)) return [];

  const slugs = fs
    .readdirSync(contentDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const posts: Omit<BlogPost, 'content'>[] = [];

  for (const slug of slugs) {
    const localePath = path.join(contentDir, slug, `${locale}.mdx`);
    const fallbackPath = path.join(contentDir, slug, 'en.mdx');
    const filePath = fs.existsSync(localePath) ? localePath : fallbackPath;

    if (!fs.existsSync(filePath)) continue;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data } = matter(raw);

    posts.push({
      slug,
      title: data.title ?? slug,
      description: data.description ?? '',
      author: data.author ?? '',
      order: data.order ?? 999,
      coverImage: data.coverImage,
      tags: data.tags ?? [],
    });
  }

  return posts.sort((a, b) => a.order - b.order);
}

export function getPostBySlug(slug: string, locale: string): BlogPost | null {
  const localePath = path.join(contentDir, slug, `${locale}.mdx`);
  const fallbackPath = path.join(contentDir, slug, 'en.mdx');
  const filePath = fs.existsSync(localePath) ? localePath : fallbackPath;

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  return {
    slug,
    title: data.title ?? slug,
    description: data.description ?? '',
    author: data.author ?? '',
    order: data.order ?? 999,
    coverImage: data.coverImage,
    tags: data.tags ?? [],
    content,
  };
}

export function getAllSlugs(): string[] {
  if (!fs.existsSync(contentDir)) return [];

  return fs
    .readdirSync(contentDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
