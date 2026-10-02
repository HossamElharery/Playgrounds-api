import { clusterQuestions } from './admin/question-clusters';

const q = (id: string, text: string, minutesAgo = 0) => ({ id, text, createdAt: new Date(Date.now() - minutesAgo * 60_000) });

describe('clusterQuestions', () => {
  it('groups the same question asked in different words and spellings', () => {
    const clusters = clusterQuestions([
      q('1', 'المايك مش شغال في اللوبي', 5),
      q('2', 'المايك مبيشتغلش في اللوبي ليه', 4),
      q('3', 'هل فيه تطبيق على الاندرويد', 3),
      q('4', 'المايك مش شغال في اللوبي', 2),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].items.map((i) => i.id).sort()).toEqual(['1', '2', '4']);
    expect(clusters[1].items.map((i) => i.id)).toEqual(['3']);
  });

  it('puts the biggest topic first and shows its latest member as the title', () => {
    const [first] = clusterQuestions([q('a', 'cancel booking refund', 30), q('b', 'cancel my booking refund', 1), q('c', 'padel in zamalek', 0)]);
    expect(first.items).toHaveLength(2);
    expect(first.sample.id).toBe('b');
  });

  it('keeps unrelated questions apart', () => {
    expect(clusterQuestions([q('1', 'سياسة الإلغاء'), q('2', 'طرق الدفع'), q('3', 'اللوبي')])).toHaveLength(3);
  });
});
