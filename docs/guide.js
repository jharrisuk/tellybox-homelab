for (const block of document.querySelectorAll('pre')) {
	const code = block.querySelector('code');
	if (!code) continue;
	block.classList.add('with-copy');
	const label = document.createElement('span');
	label.className = 'code-type';
	label.textContent = code.className.replace('language-', '') || 'Terminal';
	const button = document.createElement('button');
	button.type = 'button'; button.className = 'copy-code'; button.textContent = 'Copy';
	button.setAttribute('aria-label', 'Copy command');
	button.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(code.textContent);
			button.textContent = 'Copied';
		} catch {
			const selection = window.getSelection(), range = document.createRange();
			range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range);
			button.textContent = 'Press Ctrl/Cmd+C';
		}
		setTimeout(() => { button.textContent = 'Copy'; }, 2500);
	});
	block.append(label, button);
}
