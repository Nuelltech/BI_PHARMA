import { describe, it, expect } from 'vitest';
import { getMobileStaffHtml } from '../views/mobile_staff_view';

describe('Fase 2: UX Essencial do Piloto e Dashboard Executivo', () => {
  it('a vista móvel deve incluir botão de logout e meta tags de PWA', () => {
    const html = getMobileStaffHtml();
    expect(html).toContain('logoutMobile()');
    expect(html).toContain('manifest.webmanifest');
    expect(html).toContain('pwaInstallBanner');
  });

  it('deve ter suporte háptico de feedback e sincronização cirúrgica no mobile', () => {
    const html = getMobileStaffHtml();
    expect(html).toContain('applyLiveTaskPatch');
    expect(html).toContain('navigator.vibrate');
    expect(html).toContain('bi_pharma_offline_tasks_queue');
  });
});
