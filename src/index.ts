import { Browser, BrowserContext } from 'playwright'
import OpenAI from 'openai'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

type ScraperLoadOptions = {
  mode?: 'html' | 'text' | 'image'
  closeOnFinish?: boolean
}

type ScraperLoadResult = {
  url: string
  content: string
  mode: ScraperLoadOptions['mode']
}

type ScraperRunOptions<T extends z.ZodSchema<any>> = {
  schema: T
  model?: OpenAI.Chat.ChatModel
  instructions?: string
} & ScraperLoadOptions

type ScraperCompletionResult<T extends z.ZodSchema<any>> = {
  data: z.infer<T> | null
  url: string
}

export default class LLMScraper {
  private context: BrowserContext
  constructor(private browser: Browser) {
    this.browser = browser
  }

  // Load pages in the browser
  private async load(
    url: string | string[],
    options: ScraperLoadOptions = { mode: 'html' }
  ): Promise<Promise<ScraperLoadResult>[]> {
    this.context = await this.browser.newContext()
    const urls = Array.isArray(url) ? url : [url]

    const pages = urls.map(async (url) => {
      const page = await this.context.newPage()
      await page.goto(url)

      let content

      if (options.mode === 'html') {
        content = await page.content()
      }

      if (options.mode === 'text') {
        const readable = await page.evaluate(async () => {
          const readability = await import(
            // @ts-ignore
            'https://cdn.skypack.dev/@mozilla/readability'
          )

          return new readability.Readability(document).parse()
        })

        content = `${readable.title}\n${readable.textContent}`
      }

      if (options.mode === 'image') {
        const image = await page.screenshot()
        content = image.toString('base64')
      }

      await page.close()
      return {
        url,
        content,
        mode: options.mode,
      }
    })

    return pages
  }

  // Prepare the pages for further processing
  private preparePage(
    page: ScraperLoadResult
  ): OpenAI.Chat.Completions.ChatCompletionContentPart {
    if (page.mode === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${page.content}` },
      }
    }

    return { type: 'text', text: page.content }
  }

  // Generate completion using OpenAI
  private generateCompletions<T extends z.ZodSchema<any>>(
    pages: Promise<ScraperLoadResult>[],
    options: ScraperRunOptions<T>
  ): Promise<ScraperCompletionResult<T>>[] {
    const openai = new OpenAI()
    return pages.map(async (page, i) => {
      const p = await page
      const content = this.preparePage(p)

      const completion = await openai.chat.completions.create({
        model:
          options.model || options.mode === 'image'
            ? 'gpt-4-vision-preview'
            : 'gpt-4-turbo',
        messages: [{ role: 'user', content: [content] }],
        functions: [
          {
            name: 'extract_content',
            description:
              'Extracts the content from the given page' ||
              options.instructions,
            parameters: zodToJsonSchema(options.schema),
          },
        ],
        function_call: { name: 'extract_content' },
      })

      if (pages.length - 1 === i) {
        await this.context.close()

        if (options.closeOnFinish) {
          await this.browser.close()
        }
      }

      const c = completion.choices[0].message.function_call?.arguments
      return {
        data: JSON.parse(c ? c : 'null'),
        url: p.url,
      }
    })
  }

  // Load pages and generate completion
  async run<T extends z.ZodSchema<any>>(
    url: string | string[],
    options: ScraperRunOptions<T>
  ) {
    const pages = await this.load(url, options)
    return this.generateCompletions<T>(pages, options)
  }
}
