export const esc = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const avatar = owner => `<span class="avatar ${owner ? 'owner' : ''}" aria-hidden="true"><svg viewBox="0 0 40 40"><path fill="currentColor" d="M20 6a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM6 38v-4c0-7 6-11 14-11s14 4 14 11v4Z"/></svg></span>`;
export function textMarkup(text, known) {
  return String(text).split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map(part => {
    if (part.startsWith('`')) return `<code>${esc(part)}</code>`;
    let result = '', last = 0;
    // Conservative boundaries reject UUID components, longer hashes, filenames,
    // paths and URL tokens. Registration, not regex alone, establishes a person.
    for (const m of part.matchAll(/(^|[^A-Za-z0-9_@/\\.\-])@?(JACK|PATHFINDER|[a-f0-9]{8})(?![A-Za-z0-9_@/\\.\-])/g)) {
      const start = m.index + m[1].length, end = m.index + m[0].length;
      const token = part.slice(0, start).match(/\S*$/)[0] + part.slice(start).match(/^\S*/)[0];
      result += esc(part.slice(last, start));
      result += known.has(m[2]) && !/[\/\\]/.test(token) ? `<button type="button" class="mention ${m[2] === 'JACK' ? 'jack' : ''}" data-mention="${m[2]}">${esc(part.slice(start, end))}</button>` : esc(part.slice(start, end));
      last = end;
    }
    return result + esc(part.slice(last));
  }).join('');
}
export function messageMarkup(post, known) {
  const time = new Date(post.created).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:false });
  const stamp = `<time datetime="${esc(post.created)}">${esc(time)}</time>`;
  if (post.role === 'system') return `<div class="event"><span>${textMarkup(post.text, known)}</span>${stamp}</div>`;
  const owner = post.role === 'owner';
  return `<article class="message">${avatar(owner)}<div><header class="message-header"><span class="name ${owner ? 'jack' : ''}">${esc(post.sender)}</span>${stamp}</header><p class="body">${textMarkup(post.text, known)}</p></div></article>`;
}
