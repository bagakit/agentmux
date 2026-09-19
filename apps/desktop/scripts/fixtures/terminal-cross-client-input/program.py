import os,sys,termios,re,json,fcntl,struct
root=sys.argv[1]; attrs=termios.tcgetattr(0); attrs[3]&=~(termios.ICANON|termios.ECHO); attrs[1]&=~termios.OPOST;attrs[6][termios.VMIN]=1;attrs[6][termios.VTIME]=0;termios.tcsetattr(0,termios.TCSANOW,attrs)
index=500;reports=[];z=0;pending=b''
def save():
 with open(root+'/program-state.tmp','w') as f:json.dump({'pid':os.getpid(),'index':index,'reports':reports,'z':z},f)
 os.replace(root+'/program-state.tmp',root+'/program-state.json')
def paint():
 os.write(1,('\x1b[HPRIVATE-TUI-%03d\x1b[K\x1b[2;1HREADY%03d\x1b[K'%(index,index)).encode());save()
os.write(1,b'\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');paint()
while True:
 chunk=os.read(0,4096)
 if not chunk:break
 pending+=chunk
 while True:
  m=re.search(rb'\x1b\[<(\d+);(\d+);(\d+)(M|m)',pending)
  if not m:break
  button,x,y=map(int,m.groups()[:3]); reports.append({'button':button,'x':x,'y':y})
  if button in (64,65):index+=-3 if button==64 else 3;paint()
  else:save()
  pending=pending[m.end():]
 if b'z' in pending:z+=pending.count(b'z');pending=pending.replace(b'z',b'');os.write(1,b'\x1b[3;1HINPUT-ACK\x1b[K');save()
 if b'q' in pending:break
