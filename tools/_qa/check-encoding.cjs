const http=require('http');
http.get('http://127.0.0.1:8300/api/chain/anchor/stats',(r)=>{
  const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{
    const buf=Buffer.concat(chunks);
    console.log('content-type:',r.headers['content-type']);
    console.log('bytes:',buf.length);
    const j=JSON.parse(buf.toString('utf8'));
    console.log('PENDING:',j.data.semantics.PENDING);
    // 检测是否是"UTF-8 被当 latin1 再存"的典型乱码
    const s=j.data.semantics.PENDING;
    console.log('contains replacement char:', /[\uFFFD]/.test(s));
    console.log('looks mojibake:', /[Ã¥Ã¤Ã¦]|宸茬|閲|閿/.test(s));
  });
});
