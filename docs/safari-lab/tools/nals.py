import sys
def pes_list(path):
    b=open(path,'rb').read(); pmt=None; vpid=None; cur=None; out=[]
    for o in range(0,len(b)-187,188):
        if b[o]!=0x47: continue
        pusi=b[o+1]&0x40; pid=((b[o+1]&0x1f)<<8)|b[o+2]; afc=(b[o+3]>>4)&3; p=o+4
        if afc&2: p+=1+b[o+4]
        if not afc&1: continue
        if pid==0 and pmt is None and pusi: p+=1+b[p]; pmt=((b[p+10]&0x1f)<<8)|b[p+11]; continue
        if pid==pmt and vpid is None and pusi:
            p+=1+b[p]; sl=((b[p+1]&0xf)<<8)|b[p+2]; il=((b[p+10]&0xf)<<8)|b[p+11]; q=p+12+il; end=p+3+sl-4
            while q+5<=end:
                if b[q]==0x1b: vpid=((b[q+1]&0x1f)<<8)|b[q+2]; break
                q+=5+(((b[q+3]&0xf)<<8)|b[q+4])
            continue
        if pid==vpid:
            if pusi:
                if cur: out.append(cur)
                cur={'d':bytearray(),'pts':None}; hl=b[p+8]
                if b[p+7]&0x80:
                    x=b[p+9:p+14]; cur['pts']=((x[0]&0xe)<<29)|(x[1]<<22)|((x[2]&0xfe)<<14)|(x[3]<<7)|(x[4]>>1)
                p+=9+hl
            if cur is not None: cur['d']+=b[p:o+188]
    if cur: out.append(cur)
    return out
class R:
    def __init__(s,d,at): s.d=d; s.bit=at*8
    def rd(s): return (s.d[s.bit>>3]>>(7-(s.bit&7)))&1
    def ue(s):
        z=0
        while s.rd(): z+=0; break
        z=0
        while not s.rd(): z+=1; s.bit+=1
        s.bit+=1; v=1
        for _ in range(z): v=(v<<1)|s.rd(); s.bit+=1
        return v-1
def nals(d):
    r=[];i=0
    while i+4<len(d):
        if d[i]==0 and d[i+1]==0 and d[i+2]==1:
            t=d[i+3]&0x1f; s=''
            if t in (1,5):
                rr=R(d,i+4); rr.ue(); s='/st%d'%(rr.ue()%5)
            r.append('%d%s'%(t,s)); i+=4
        else: i+=1
    return r
for path in sys.argv[1:]:
    print('==',path.split('/')[-1])
    for k,pe in enumerate(pes_list(path)[:14]): print(k,pe['pts'],len(pe['d']),' '.join(nals(bytes(pe['d'][:600]))))
