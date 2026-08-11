import { defineConfig } from 'vitepress'

const enNav = [
  { text: 'Guide', link: '/getting-started' },
  { text: 'API', link: '/api' },
  { text: 'GitHub', link: 'https://github.com/kaecho/ipv6-subnet-proxy' },
]

const zhNav = [
  { text: '指南', link: '/zh/getting-started' },
  { text: 'API', link: '/zh/api' },
  { text: 'GitHub', link: 'https://github.com/kaecho/ipv6-subnet-proxy' },
]

const enSidebar = [
  {
    text: 'Guide',
    items: [
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Features', link: '/features' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'No IPv6 on the Host', link: '/no-ipv6' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'SOCKS5 Usage', link: '/socks5' },
      { text: 'IPv4-Only Names', link: '/ipv4-only' },
      { text: 'Docker', link: '/docker' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'REST API', link: '/api' },
      { text: 'Data Model', link: '/data-model' },
      { text: 'Rate Limiting', link: '/rate-limiting' },
      { text: 'Development', link: '/development' },
      { text: 'CI/CD', link: '/cicd' },
    ],
  },
]

const zhSidebar = [
  {
    text: '指南',
    items: [
      { text: '快速开始', link: '/zh/getting-started' },
      { text: '功能特性', link: '/zh/features' },
      { text: '架构设计', link: '/zh/architecture' },
      { text: '宿主机没有 IPv6', link: '/zh/no-ipv6' },
      { text: '配置说明', link: '/zh/configuration' },
      { text: 'SOCKS5 使用', link: '/zh/socks5' },
      { text: '无 IPv6 域名', link: '/zh/ipv4-only' },
      { text: 'Docker 部署', link: '/zh/docker' },
    ],
  },
  {
    text: '参考',
    items: [
      { text: 'REST API', link: '/zh/api' },
      { text: '数据模型', link: '/zh/data-model' },
      { text: '速率限制', link: '/zh/rate-limiting' },
      { text: '开发指南', link: '/zh/development' },
      { text: 'CI/CD', link: '/zh/cicd' },
    ],
  },
]

export default defineConfig({
  title: 'IPv6 Subnet Proxy',
  description: 'SOCKS5 proxy that distributes connections across an IPv6 subnet',
  // GitHub Pages project site: https://kaecho.github.io/ipv6-subnet-proxy/
  base: '/ipv6-subnet-proxy/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  srcExclude: ['**/superpowers/**'],

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
        socialLinks: [
          { icon: 'github', link: 'https://github.com/kaecho/ipv6-subnet-proxy' },
        ],
        editLink: {
          pattern: 'https://github.com/kaecho/ipv6-subnet-proxy/edit/master/docs/:path',
          text: 'Edit this page on GitHub',
        },
        footer: {
          message: 'Released under the MIT License.',
          copyright: 'Copyright © IPv6 Subnet Proxy contributors',
        },
      },
    },
    zh: {
      label: '中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'IPv6 子网代理',
      description: '将出站连接分布到 IPv6 子网中不同地址的 SOCKS5 代理',
      themeConfig: {
        nav: zhNav,
        sidebar: zhSidebar,
        socialLinks: [
          { icon: 'github', link: 'https://github.com/kaecho/ipv6-subnet-proxy' },
        ],
        editLink: {
          pattern: 'https://github.com/kaecho/ipv6-subnet-proxy/edit/master/docs/:path',
          text: '在 GitHub 上编辑此页',
        },
        footer: {
          message: '基于 MIT 许可证发布。',
          copyright: 'Copyright © IPv6 Subnet Proxy 贡献者',
        },
        docFooter: {
          prev: '上一页',
          next: '下一页',
        },
        outline: { label: '本页目录' },
        lastUpdated: { text: '最后更新' },
        darkModeSwitchLabel: '主题',
        lightModeSwitchTitle: '切换到浅色',
        darkModeSwitchTitle: '切换到深色',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '回到顶部',
        langMenuLabel: '切换语言',
      },
    },
  },
})
