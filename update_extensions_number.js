const fs = require('fs');

const file = '/Users/hunter/Documents/Dockers/Containers/avr-infra/asterisk_dynamic/extensions_dynamic.conf';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /same => n,Set\(MAP_BODY=\{"uuid":"\$\{UUID\}","agentId":"([^"]+)","direction":"\$\{CALL_DIRECTION\}"\}\)/g,
  'same => n,Set(CUSTOMER_NUMBER=${IF($["${CUSTOMER_NUMBER}"=""]?${CALLERID(num)}:${CUSTOMER_NUMBER})})\n  same => n,Set(MAP_BODY={"uuid":"${UUID}","agentId":"$1","direction":"${CALL_DIRECTION}","customerNumber":"${CUSTOMER_NUMBER}"})'
);

fs.writeFileSync(file, content);
console.log('Extensions updated with customerNumber');
