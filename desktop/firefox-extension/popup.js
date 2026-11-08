'use strict'
const TEXT = {
  connected: ['Подключено', 'Агент Mouse King Pro видит ваши вкладки. Клики, ввод текста, открытие и закрытие вкладок — только после вашего подтверждения в приложении.'],
  unpaired: ['Ждёт подключения', 'В Mouse King Pro откройте Настройки → Firefox и нажмите «Подключить» — связь установится сама.'],
  offline: ['Приложение не запущено', 'Запустите Mouse King Pro на этом компьютере — расширение подключится само.'],
}
function show(state) {
  const [t, h] = TEXT[state] || TEXT.offline
  document.getElementById('st').className = 'st ' + state
  document.getElementById('t').textContent = t
  document.getElementById('hint').textContent = h
}
browser.runtime.sendMessage({ type: 'getState' }).then((r) => show(r && r.state))
browser.runtime.onMessage.addListener((m) => m && m.type === 'state' && show(m.state))
