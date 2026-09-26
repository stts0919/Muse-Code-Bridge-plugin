const status = document.querySelector("#copy-status");
document.querySelectorAll(".copy-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const code = button.closest(".code-block").querySelector("code").textContent;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "已複製";
      status.textContent = `${button.getAttribute("aria-label")}：已複製。`;
    } catch {
      button.textContent = "請手動選取";
      status.textContent = "瀏覽器無法使用剪貼簿，請手動選取並複製指令。";
    }
    window.setTimeout(() => { button.textContent = "複製"; }, 2400);
  });
});

const links = [...document.querySelectorAll(".sidebar nav a")];
const sections = [...document.querySelectorAll("main section")];
function updateSection() {
  const threshold = window.innerWidth <= 760 ? 164 : 130;
  let active = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= threshold) active = section;
  }
  for (const link of links) {
    if (link.getAttribute("href") === `#${active.id}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
let scheduled = false;
window.addEventListener("scroll", () => {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(() => { updateSection(); scheduled = false; });
}, { passive: true });
window.addEventListener("resize", updateSection);
updateSection();
