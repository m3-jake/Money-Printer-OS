// The desktop expects double-clicks on icons. A phone tap opens the same app.
document.getElementById('icons')?.addEventListener('click', event => {
  if (!matchMedia('(max-width: 600px)').matches) return;
  const icon = event.target.closest('.icon');
  if (!icon) return;
  event.stopPropagation();
  icon.ondblclick?.();
}, true);

const mobileIcons = document.getElementById('icons');
const iconScrollCue = document.getElementById('iconScrollCue');
function updateIconScrollCue() {
  if (!mobileIcons || !iconScrollCue) return;
  const overflow = mobileIcons.scrollWidth > mobileIcons.clientWidth + 4;
  const atEnd = mobileIcons.scrollLeft >= mobileIcons.scrollWidth - mobileIcons.clientWidth - 4;
  iconScrollCue.classList.toggle('is-hidden', !overflow);
  iconScrollCue.classList.toggle('is-end', atEnd);
  iconScrollCue.innerHTML = atEnd ? '<b>‹</b> SWIPE' : 'SWIPE <b>›</b>';
}
mobileIcons?.addEventListener('scroll', updateIconScrollCue, { passive: true });
addEventListener('resize', updateIconScrollCue);
requestAnimationFrame(updateIconScrollCue);
