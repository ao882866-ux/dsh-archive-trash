window.__ModuleLoader__.load({
  id: "dsh-session-archive",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client-src/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React2 = __toESM(require("react"), 1);

// client-src/delete-button.js
var React = __toESM(require("react"), 1);
var h = React.createElement;
var CONFIRM_TIMEOUT_MS = 5e3;
var TRASH_PATHS = [
  "M1.28149 3.88831H14.7187",
  "M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833",
  "M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831",
  "M6.44946 6.98926V11.1238",
  "M9.55054 6.98926V11.1238"
];
var TRASH_ICON_SIZE = 14;
function TrashIcon({ size = TRASH_ICON_SIZE }) {
  return h("svg", {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": "true",
    strokeWidth: 1,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, TRASH_PATHS.map((d, i) => h("path", { key: i, d, stroke: "currentColor" })));
}
var S = {
  /**
   * 与同排 `iconButton` 同一盒子：16×16、零 padding。
   *
   * 颜色只表达状态，**不改变盒子尺寸**，故两种状态间不会重排。
   */
  button: (armed, busy) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    boxSizing: "border-box",
    // 与自带 iconButton 的 16×16 对齐 —— 这是「间隔对齐」的关键。
    width: "16px",
    height: "16px",
    padding: 0,
    margin: 0,
    // 显式写 borderWidth/borderStyle 而非简写 `border:'none'`：
    // 简写在部分引擎里会归一化成 `borderWidth: medium`，让「零边框」无法断言。
    borderWidth: 0,
    borderStyle: "none",
    borderRadius: "var(--dsw-radius-xs)",
    background: "none",
    // 常态与自带按钮同为 tertiary；上膛（或失败）转 error —— 用户要求的红色。
    color: armed ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)",
    cursor: busy ? "wait" : "pointer",
    opacity: busy ? 0.6 : 1
  })
};
function DeleteArchivedSessionButton({ sessionId, rpcCall, archivedSetSnapshot }) {
  const [armed, setArmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => () => {
    mounted.current = false;
  }, []);
  React.useEffect(() => {
    if (!armed) return void 0;
    const timer = setTimeout(() => {
      if (mounted.current) setArmed(false);
    }, CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const archived = archivedSetSnapshot().has(sessionId);
  if (!archived) return null;
  const onClick = async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      setFailed(false);
      return;
    }
    setBusy(true);
    try {
      await rpcCall("archive.delete", { sessionId });
    } catch {
      if (mounted.current) {
        setArmed(false);
        setFailed(true);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const title = failed ? "删除失败，点击重试" : armed ? "再次点击即永久删除该会话（不可恢复）" : "永久删除该归档会话（不可恢复）";
  return h(
    "button",
    {
      type: "button",
      style: S.button(armed || failed, busy),
      // 行内按钮条里的点击不会冒泡到行本身（DSH 的 strip 契约），
      // 但显式阻止一次更稳妥 —— 否则点删除会顺带打开该会话。
      onClick: (event) => {
        event.stopPropagation();
        void onClick();
      },
      // 失焦即取消，避免「上膛」状态在用户切走后被误触。
      onBlur: () => {
        if (!busy) setArmed(false);
      },
      // 悬停提升图标色（inline style 写不了 :hover）。上膛时保持红色。
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      title,
      "aria-label": armed ? `确认删除会话 ${sessionId}` : `删除归档会话 ${sessionId}`,
      "data-armed": armed ? "true" : void 0,
      "data-failed": failed ? "true" : void 0
    },
    h("span", {
      style: {
        display: "inline-flex",
        // 悬停且未上膛时提升为 primary；上膛/失败由外层红色统一控制。
        color: !armed && !failed && hovered ? "var(--dsw-alias-label-primary)" : "inherit"
      }
    }, h(TrashIcon, { size: TRASH_ICON_SIZE }))
  );
}

// client-src/index.js
var name = "session-archive-client";
var inject = ["slots", "connection"];
var CHANNEL = "session-archive";
async function callRpc(connection, method, payload, signal) {
  const result = await connection.rpc.call("/api", CHANNEL, { method, payload }, signal);
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || "归档管理请求失败");
    error.code = result.error?.code;
    throw error;
  }
  return result;
}
function apply(ctx) {
  const rpcCall = (method, payload, signal) => callRpc(ctx.connection, method, payload, signal);
  function archivedSetSnapshot() {
    const workspaces = ctx.get?.("workspaces");
    const snapshot = workspaces?.list?.getSnapshot?.();
    const ids = snapshot?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids : []);
  }
  ctx.slots.inject("sidebar.workspaces.session.row.action", () => ctx.slots.register({
    name: "sidebar.workspaces.session.row.action",
    id: "session-archive-delete",
    // 排在 DSH 自带的 archive(100) 与 pin(200) 之后。
    order: 300,
    inject: () => ({ rpcCall, archivedSetSnapshot })
  }, DeleteArchivedSessionButton));
}

    return module.exports;
  }
});
