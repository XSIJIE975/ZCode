// AliyunCaptcha 隐藏宿主 DOM：SDK 初始化需要一个常驻挂载点与触发按钮（发行版 Xtn）。
// 两者 0 尺寸且不可聚焦；弹出的验证窗由 SDK 自行 teleport 到 body。
export function CaptchaHostElements() {
  return (
    <div
      className="pointer-events-none fixed left-0 top-0 z-[2147483647] h-0 w-0 overflow-visible"
      aria-hidden={true}
    >
      <div id="zcode-aliyun-captcha-element" />
      <button
        id="zcode-aliyun-captcha-button"
        type="button"
        tabIndex={-1}
        className="absolute left-1/2 top-1/2 h-px w-px opacity-0"
      />
    </div>
  );
}
