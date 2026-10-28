/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * **装配哪个外壳 profile**（见 `composition/shell.ts`）。
   *
   * 取值是 profile id（`workbench` / `embed` / `wiki` / `headless`），
   * **不是**旧变量那种"宿主是谁"。两者语义不同，故不做名字映射。
   */
  readonly VITE_SHELL_PROFILE?: 'workbench' | 'embed' | 'wiki' | 'headless'
}

/**
 * 旧宿主变量 `VITE_HOST_PROFILE` **不在此声明**。
 *
 * 它由不可修改的共享构建配置（`vite.wiki-workbench.config.ts`）注入，
 * 且全 `src/` 只有**一处**读取：`composition/shell.ts#resolveShellProfile`
 * （经一个宽类型记录读，故不需要这里的类型声明）。
 *
 * 不在此声明的第二个理由：声明它会让 `import.meta.env.VITE_HOST_PROFILE`
 * 在**任何**模块里都能通过类型检查 —— 那正是旧形态复发的最短路径。
 * 让它类型不可见，等于给"再读一次"加了一道编译期摩擦。
 */

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
