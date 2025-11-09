
// Hackopoly UI theme toggler (separate from map theme)
export function applyHackopolyUI(){
  const el = document.getElementById('ui-root')
  if(el) el.classList.add('hackopoly-ui')
  if(el) el.setAttribute('data-theme', 'hackopoly')
  return !!el
}
export function removeHackopolyUI(){
  const el = document.getElementById('ui-root')
  if(el){
    el.classList.remove('hackopoly-ui')
    el.removeAttribute('data-theme')
  }
  return !!el
}
if(typeof window !== 'undefined'){
  window.applyHackopolyUI = applyHackopolyUI;
  window.removeHackopolyUI = removeHackopolyUI;
}
