const slider = document.querySelector('#reveal');
const comparison = document.querySelector('.comparison');
const value = document.querySelector('#reveal-value');

if (slider && comparison && value) {
  const update = () => {
    comparison.style.setProperty('--reveal', `${slider.value}%`);
    value.value = `${slider.value}%`;
    value.textContent = `${slider.value}%`;
  };
  slider.addEventListener('input', update);
  update();
}
