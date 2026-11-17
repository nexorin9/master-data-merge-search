import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative: string): string => readFileSync(resolve(projectRoot, relative), 'utf8')

describe('工程脚手架', () => {
  it('package.json 名称与脚本齐备', () => {
    const pkg = JSON.parse(read('package.json')) as {
      name: string
      scripts: Record<string, string>
      packageManager: string
    }
    expect(pkg.name).toBe('master-data-merge-search')
    expect(pkg.packageManager).toMatch(/^pnpm@/)
    for (const script of ['dev', 'build', 'preview', 'test']) {
      expect(pkg.scripts[script], `缺少脚本 ${script}`).toBeTruthy()
    }
  })

  it('二维码已随项目落盘且未被 .gitignore 排除', () => {
    expect(existsSync(resolve(projectRoot, 'qrcode.jpg'))).toBe(true)
    const ignore = read('.gitignore')
    expect(ignore).not.toMatch(/qrcode/)
  })

  it('运行时文件与凭据文件被 .gitignore 覆盖', () => {
    const ignore = read('.gitignore')
    for (const entry of [
      'node_modules/',
      'dist/',
      'out/',
      'coverage/',
      'logs/',
      'data/',
      '__pycache__/',
      '.pytest_cache/',
      '.env',
      'score.json',
    ]) {
      expect(ignore, `未排除 ${entry}`).toContain(entry)
    }
  })

  it('docs/concepts 与 docs/screenshots 目录已建', () => {
    expect(existsSync(resolve(projectRoot, 'docs/concepts'))).toBe(true)
    expect(existsSync(resolve(projectRoot, 'docs/screenshots'))).toBe(true)
  })

  it('视觉目标卡落盘且含四个小节', () => {
    const card = read('docs/concepts/visual-target-p1.md')
    for (const heading of ['7.1 三个状态', '7.2 画面类型', '7.3 视觉语言', '7.4 必须可达的约束']) {
      expect(card, `视觉目标卡缺少 ${heading}`).toContain(heading)
    }
    // 没有图像生成能力时不得放占位图
    expect(card).not.toMatch(/!\[.*\]\(.*\.png\)/)
  })
})

describe('README 结构契约', () => {
  const readme = read('README.md')

  it('标题与一句话说明到位', () => {
    expect(readme.startsWith('# 主数据归并检索系统')).toBe(true)
    expect(readme).toMatch(/^> .+/m)
  })

  it('强制章节齐全且顺序正确', () => {
    const headings = readme
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => line.replace('## ', '').trim())
    expect(headings).toEqual([
      '适用场景 / 目标岗位',
      '能力要点',
      '快速开始',
      '命令 / API / 配置说明',
      '典型场景',
      '输出样例',
      '概念 / 实测对照',
      '架构与数据流',
      '安全与合规边界',
      '验收与自检',
      '项目结构',
      'License',
      '关注我们',
    ])
  })

  it('快速开始与命令说明带子节', () => {
    for (const heading of [
      '### 依赖',
      '### 安装',
      '### 配置',
      '### 构建与验证',
      '### 主命令速查',
      '### 关键配置项',
      '### CLI 子命令 / 接口端点',
      '### 错误与降级',
      '### 对接现有系统',
      '### 视觉目标',
      '### 实测证据',
      '### 关键不变量',
    ]) {
      expect(readme, `README 缺少 ${heading}`).toContain(heading)
    }
  })

  it('文档丰度达到交付下限', () => {
    const tableRows = readme.split('\n').filter((line) => line.startsWith('|')).length
    const codeFences = readme.split('\n').filter((line) => line.startsWith('```')).length
    expect(readme.length).toBeGreaterThanOrEqual(5000)
    expect(readme.split('\n').filter((line) => line.startsWith('## ')).length).toBeGreaterThanOrEqual(10)
    expect(readme.split('\n').filter((line) => line.startsWith('### ')).length).toBeGreaterThanOrEqual(8)
    expect(tableRows).toBeGreaterThanOrEqual(5)
    expect(codeFences).toBeGreaterThanOrEqual(8)
    expect(readme).toContain('┌')
    expect(readme).toContain('└')
  })

  it('关注区块与实测截图路径被引用', () => {
    expect(readme).toContain('## 关注我们')
    expect(readme).toContain('![关注我们](qrcode.jpg)')
    expect(readme).toContain('docs/screenshots/')
  })

  it('不得出现上游开源项目名或研发黑话标题', () => {
    expect(readme).not.toMatch(/airi/i)
    expect(readme).not.toMatch(/tamagotchi/i)
    expect(readme).not.toMatch(/基于\s*\S+\s*项目/)
  })
})
