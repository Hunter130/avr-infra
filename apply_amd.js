const fs = require('fs');

const file = '/Users/hunter/Documents/Dockers/Containers/avr-infra/asterisk_dynamic/extensions_dynamic.conf';
let content = fs.readFileSync(file, 'utf8');

// Replace CALL_DIRECTION logic
content = content.replace(
  /same => n,Set\(CALL_DIRECTION=\$\{IF\(\$\["\$\{CALL_DIRECTION\}"=""\]\?inbound:\$\{CALL_DIRECTION\}\)\}\)\n\s+same => n,Set\(CUSTOMER_NUMBER/g,
  `same => n,Set(CALL_DIRECTION=\\$\\{IF(\\$\\["\\$\\{CALL_DIRECTION\\}"=""]?inbound:\\$\\{CALL_DIRECTION\\})})
  same => n,GotoIf(\\$\\["\\$\\{CALL_DIRECTION\\}"="inbound"]?skipamd)
  same => n,AMD()
  same => n,GotoIf(\\$\\["\\$\\{AMDSTATUS\\}"="MACHINE"]?hangup_machine)
  same => n(skipamd),NoOp(AMD Done or Skipped)
  same => n,Set(CUSTOMER_NUMBER`
);

// Replace Hangup logic
content = content.replace(
  /same => n,Dial\(AudioSocket\/avr-core:5001\/\$\{UUID\}\)\n\s+same => n,Hangup\(\)/g,
  `same => n,Dial(AudioSocket/avr-core:5001/\\$\\{UUID\\})
  same => n,Hangup()
  same => n(hangup_machine),NoOp(Machine detected, hanging up)
  same => n,Hangup()`
);

fs.writeFileSync(file, content);
console.log('Extensions updated with AMD logic');
