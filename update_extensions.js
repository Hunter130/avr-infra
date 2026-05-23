const fs = require('fs');

const file = '/Users/hunter/Documents/Dockers/Containers/avr-infra/asterisk_dynamic/extensions_dynamic.conf';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /same => n,Set\(MAP_BODY=\{"uuid":"\$\{UUID\}","agentId":"([^"]+)"\}\)/g,
  'same => n,Set(CALL_DIRECTION=${IF($["${CALL_DIRECTION}"=""]?inbound:${CALL_DIRECTION})})\n  same => n,Set(MAP_BODY={"uuid":"${UUID}","agentId":"$1","direction":"${CALL_DIRECTION}"})'
);

fs.writeFileSync(file, content);
console.log('Extensions updated');
